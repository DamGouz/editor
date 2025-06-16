//! src/main.rs
//! ——— dependencies you must have in Cargo.toml ———
//! axum = { version = "0.6.20", features = ["macros", "json", "tokio", "stream"] }
//! tower-http = "0.5"
//! base64  = "0.21"
//! walkdir = "2.4"
//! zip     = { version = "0.6", default-features = false, features = ["deflate"] }
//! tokio   = { version = "1", features = ["full"] }
//! tracing = "0.1"
//! tracing-subscriber = { version = "0.3", features = ["env-filter"] }
//! (plus your existing crates: zen_engine, serde, serde_json, etc.)

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Extension, Json, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    fs,
    io::Read,
    io::Cursor,
    path::{Component, Path as StdPath, PathBuf},
    sync::{Arc, Mutex},
    thread::available_parallelism,
};
use tokio::fs as tokio_fs;
use tokio_util::{io::ReaderStream, task::LocalPoolHandle};
use tower_http::{
    compression::CompressionLayer, cors::CorsLayer, services::{ServeDir, ServeFile},
    set_status::SetStatus, trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use walkdir::WalkDir;
use zip::ZipArchive;
use zen_engine::{loader::{FilesystemLoader, FilesystemLoaderOptions}, DecisionEngine, EvaluationError, EvaluationOptions};

const IS_DEVELOPMENT: bool = cfg!(debug_assertions);
const STORAGE_ROOT: &str = "./decisions";
const HEAD_FILE: &str = "./decisions/HEAD";

// ===== storage bootstrap =====================================================

fn ensure_storage_root() {
    fs::create_dir_all(format!("{STORAGE_ROOT}/0")).expect("create storage root");
    if !StdPath::new(HEAD_FILE).exists() {
        fs::write(HEAD_FILE, b"0").expect("write HEAD");
    }
}

// ===== helpers ===============================================================

fn safe_path(user: &str) -> Result<PathBuf, StatusCode> {
    let mut p = PathBuf::from(STORAGE_ROOT);
    for comp in StdPath::new(user).components() {
        match comp {
            Component::Normal(c) => p.push(c),
            Component::CurDir => {}
            _ => return Err(StatusCode::BAD_REQUEST),
        }
    }
    Ok(p)
}

#[derive(Serialize)]
struct SearchHit {
    path: String,
    matched: &'static str, // "name", "content"
}

fn read_head() -> u64 {
    fs::read_to_string(HEAD_FILE)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn write_head(n: u64) {
    fs::write(HEAD_FILE, n.to_string()).expect("write HEAD");
}

fn bump_rev(lock: &Arc<Mutex<()>>) -> u64 {
    let _g = lock.lock().unwrap();
    let n = read_head() + 1;
    fs::create_dir_all(format!("{STORAGE_ROOT}/{n}")).expect("new rev dir");
    write_head(n);
    n
}

// ===== file-tree DTO =========================================================

#[derive(Serialize)]
struct Node {
    name: String,
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    modified: i64,
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<Node>>,
}

fn build_tree(root_fs: &StdPath, rel: &str) -> Vec<Node> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(root_fs) {
        for e in entries.flatten() {
            let meta = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let name = e.file_name().to_string_lossy().into_owned();
            let node_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let children = if is_dir { Some(build_tree(&e.path(), &node_path)) } else { None };
            out.push(Node {
                name,
                path: node_path,
                is_directory: is_dir,
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or_default(),
                size: (!is_dir).then(|| meta.len()),
                children,
            });
        }
        out.sort_by_key(|n| (!n.is_directory, n.name.to_lowercase()));
    }
    out
}

// ===== request/response models ==============================================

#[derive(Deserialize)]
struct PathContent {
    path: String,
    content: String,
}
#[derive(Deserialize)]
struct Rename {
    from: String,
    to: String,
}
#[derive(Deserialize)]
struct Mkdir {
    path: String,
}
#[derive(Deserialize)]
struct RevCreateReq {
    zip_b64: String,
}
#[derive(Serialize)]
struct NewRevResp {
    id: u64,
}
#[derive(Serialize)]
struct RevListResp {
    latest: u64,
    list: Vec<u64>,
}

// ===== global state ==========================================================

#[derive(Clone)]
struct AppState {
    rev_lock: Arc<Mutex<()>>,
}

// ===== /api/fs/* ============================================================

async fn fs_search(Query(p): Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    let needle = match p.get("q") {
        Some(q) if !q.is_empty() => q.to_lowercase(),
        _ => return (StatusCode::BAD_REQUEST, "missing ?q=").into_response(),
    };
    let sub = p.get("path").cloned().unwrap_or_default();

    let root = match safe_path(&sub) {
        Ok(p) if p.exists() => p,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };

    // Do the heavy IO in a blocking thread and return the Vec<SearchHit>
    let hits: Vec<SearchHit> = match tokio::task::spawn_blocking(move || {
        let mut out = Vec::<SearchHit>::new();

        for entry in WalkDir::new(&root).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(STORAGE_ROOT)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");

            // --- name match --------------------------------------------------
            if rel.to_lowercase().contains(&needle) {
                out.push(SearchHit { path: rel, matched: "name" });
                continue;
            }

            // --- content match ----------------------------------------------
            if let Ok(mut f) = std::fs::File::open(entry.path()) {
                let mut buf = String::new();
                if f.metadata().map(|m| m.len()).unwrap_or(0) <= 1_000_000 {
                    if f.read_to_string(&mut buf).is_ok()
                        && buf.to_lowercase().contains(&needle)
                    {
                        out.push(SearchHit { path: rel, matched: "content" });
                    }
                }
            }
        }

        out // returned from the closure
    })
    .await
    {
        Ok(h) => h,
        Err(e) => {
            tracing::error!("search task panicked: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    Json(hits).into_response()
}

async fn fs_list(Query(p): Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    let sub = p.get("path").cloned().unwrap_or_default();
    match safe_path(&sub) {
        Ok(root) if root.exists() => Json(build_tree(&root, &sub)).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn fs_read(Query(p): Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    let path = p.get("path").cloned().unwrap_or_default();
    match safe_path(&path) {
        Ok(full) if full.is_file() => match tokio_fs::read_to_string(full).await {
            Ok(c) => Json(c).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn fs_save(Json(body): Json<PathContent>) -> impl IntoResponse {
    match safe_path(&body.path) {
        Ok(full) => {
            if let Some(parent) = full.parent() {
                if let Err(e) = tokio_fs::create_dir_all(parent).await {
                    tracing::error!("mkdir error: {e}");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            match tokio_fs::write(full, body.content).await {
                Ok(_) => StatusCode::CREATED.into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}
async fn fs_write(Json(body): Json<PathContent>) -> impl IntoResponse { fs_save(Json(body)).await }

async fn fs_rename(Json(body): Json<Rename>) -> impl IntoResponse {
    match (safe_path(&body.from), safe_path(&body.to)) {
        (Ok(src), Ok(dst)) => {
            if let Some(parent) = dst.parent() {
                if let Err(e) = tokio_fs::create_dir_all(parent).await {
                    tracing::error!("mkdir error: {e}");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            }
            match tokio_fs::rename(src, dst).await {
                Ok(_) => StatusCode::NO_CONTENT.into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn fs_delete(Json(body): Json<Mkdir>) -> impl IntoResponse {
    match safe_path(&body.path) {
        Ok(target) => {
            if tokio_fs::metadata(&target).await.is_err() {
                return StatusCode::NOT_FOUND.into_response();
            }
            let result = if target.is_dir() {
                tokio_fs::remove_dir_all(target).await
            } else {
                tokio_fs::remove_file(target).await
            };
            match result {
                Ok(_) => StatusCode::NO_CONTENT.into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn fs_mkdir(Json(body): Json<Mkdir>) -> impl IntoResponse {
    match safe_path(&body.path) {
        Ok(target) => match tokio_fs::create_dir_all(target).await {
            Ok(_) => StatusCode::CREATED.into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn fs_snapshot(State(st): State<AppState>) -> impl IntoResponse {
    let new_rev = bump_rev(&st.rev_lock);
    let src = format!("{STORAGE_ROOT}/{}", new_rev - 1);
    let dst = format!("{STORAGE_ROOT}/{new_rev}");
    if let Err(e) = copy_dir_all(&src, &dst) {
        tracing::error!("snapshot copy error: {e}");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(NewRevResp { id: new_rev }).into_response()
}

// ===== /api/revisions/* ======================================================

async fn rev_list() -> impl IntoResponse {
    let latest = read_head();
    Json(RevListResp { latest, list: (0..=latest).collect() })
}

async fn rev_create(State(st): State<AppState>, Json(body): Json<RevCreateReq>) -> impl IntoResponse {
    let new_rev = bump_rev(&st.rev_lock);
    let dest = format!("{STORAGE_ROOT}/{new_rev}");
    if let Err(e) = tokio_fs::create_dir_all(&dest).await {
        tracing::error!("mkdir error {e}");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    // decode & unzip on blocking thread
    let res = tokio::task::spawn_blocking(move || -> Result<(), anyhow::Error> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(body.zip_b64.as_bytes())?;
        let mut archive = ZipArchive::new(Cursor::new(bytes))?;
        for i in 0..archive.len() {
            let mut f = archive.by_index(i)?;
            let out_path = StdPath::new(&dest).join(f.name());
            if f.is_dir() {
                fs::create_dir_all(&out_path)?;
            } else {
                if let Some(p) = out_path.parent() {
                    fs::create_dir_all(p)?;
                }
                let mut w = fs::File::create(out_path)?;
                std::io::copy(&mut f, &mut w)?;
            }
        }
        Ok(())
    })
    .await;

    match res {
        Ok(Ok(())) => Json(NewRevResp { id: new_rev }).into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct RevFileParams {
    rev: u64,
    path: String,
}

async fn rev_file(Query(q): Query<RevFileParams>) -> impl IntoResponse {
    match safe_path(&format!("{}/{}", q.rev, q.path)) {
        Ok(full) if full.is_file() => match tokio_fs::File::open(full).await {
            Ok(file) => {
                let stream  = ReaderStream::new(file);
                let body    = Body::from_stream(stream);
            
                let mut headers = HeaderMap::new();
                headers.insert(
                    header::CONTENT_TYPE,
                    "application/octet-stream".parse().unwrap(),
                );
            
                (headers, body).into_response()          // ← add `.into_response()`
            }
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

// ===== helper: recursive copy ===============================================

fn copy_dir_all(src: &str, dst: &str) -> std::io::Result<()> {
    for entry in WalkDir::new(src) {
        let entry = entry?;
        let rel = entry.path().strip_prefix(src).unwrap();
        let dest_path = StdPath::new(dst).join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest_path)?;
        } else {
            if let Some(p) = dest_path.parent() {
                fs::create_dir_all(p)?;
            }
            fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}

// ===== simulate (unchanged) ==================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimulateRequest {
    root_dir: String,
    filepath: String,
    context: Value,
}

async fn simulate(
    Extension(local_pool): Extension<LocalPoolHandle>,
    Json(req): Json<SimulateRequest>,
) -> Result<Json<Value>, SimulateError> {
    // 1. Filesystem loader --------------------------------------------------
    let loader = FilesystemLoader::new(FilesystemLoaderOptions {
        root: req.root_dir.clone(),
        keep_in_memory: true,
    });
    let engine = DecisionEngine::default().with_loader(loader.into());

    // 2. Evaluation options --------------------------------------------------
    let opts = EvaluationOptions { trace: Some(true), max_depth: Some(50) };

    let result = local_pool
        .spawn_pinned(move || async move {
            engine
                .evaluate_with_opts(&req.filepath, req.context.into(), opts)
                .await
                // -------- flatten here: serialization can’t really fail -------
                .map(|v| serde_json::to_value(v).expect("serialize DecisionGraphResponse"))
        })
        .await
        .expect("thread join failed")?;   // ← only **one** `?` now

    Ok(Json(result))
}

struct SimulateError(Box<EvaluationError>);

impl IntoResponse for SimulateError {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, serde_json::to_string(&self.0).unwrap_or_default()).into_response()
    }
}
impl From<Box<EvaluationError>> for SimulateError {
    fn from(value: Box<EvaluationError>) -> Self { Self(value) }
}

// ===== misc small endpoints ==================================================

async fn health() -> (StatusCode, &'static str) { (StatusCode::OK, "healthy") }

fn serve_dir_service() -> ServeDir<SetStatus<ServeFile>> {
    let work_dir = env::current_dir().unwrap_or_else(|_| StdPath::new(".").to_path_buf());
    let static_path = work_dir.join("static");
    let index_path = static_path.join("index.html");
    ServeDir::new(static_path).not_found_service(ServeFile::new(index_path))
}

// ===== main ==================================================================

#[tokio::main]
async fn main() {
    ensure_storage_root();

    let local_pool = LocalPoolHandle::new(available_parallelism().map(Into::into).unwrap_or(1));

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "editor=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let host = IS_DEVELOPMENT.then_some("127.0.0.1").unwrap_or("0.0.0.0");
    let addr = format!("{host}:3000");

    let app_state = AppState { rev_lock: Arc::new(Mutex::new(())) };

    let app = Router::new()
        // original routes
        .route("/api/health", get(health))
        .route("/api/simulate", post(simulate).layer(DefaultBodyLimit::max(16 * 1024 * 1024)))
        // file service
        .route("/api/fs/search",    get(fs_search))
        .route("/api/fs/list",      get(fs_list))
        .route("/api/fs/read",      get(fs_read))
        .route("/api/fs/save",      post(fs_save))
        .route("/api/fs/write",     post(fs_write))
        .route("/api/fs/rename",    post(fs_rename))
        .route("/api/fs/delete",    post(fs_delete))
        .route("/api/fs/mkdir",     post(fs_mkdir))
        .route("/api/fs/snapshot",  post(fs_snapshot))
        // revisions
        .route("/api/revisions",          get(rev_list).post(rev_create))
        .route("/api/revisions/file",     get(rev_file))
        .with_state(app_state)
        .layer(Extension(local_pool))
        .nest_service("/", serve_dir_service());

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    let compression = CompressionLayer::new().gzip(true).br(true);

    tracing::info!("🚀 listening on http://{}", listener.local_addr().unwrap());

    let mut stacked = app.layer(TraceLayer::new_for_http()).layer(compression);
    if env::var("CORS_PERMISSIVE").is_ok() {
        stacked = stacked.layer(CorsLayer::permissive());
    }

    axum::serve(listener, stacked).await.unwrap();
}

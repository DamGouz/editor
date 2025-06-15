# flask_server.py

from flask import Flask, request, jsonify, send_file, abort
import os
import shutil
import zipfile
import base64
import io

app = Flask(__name__)
STORAGE_ROOT = "./decisions"

# Ensure STORAGE_ROOT/0 and HEAD exist at startup
os.makedirs(f"{STORAGE_ROOT}/0", exist_ok=True)
head_path = os.path.join(STORAGE_ROOT, "HEAD")
if not os.path.exists(head_path):
    with open(head_path, "w") as f:
        f.write("0")

# Helpers

def read_head():
    with open(head_path) as f:
        return int(f.read().strip())

def write_head(n):
    with open(head_path, "w") as f:
        f.write(str(n))

def current_rev():
    return read_head()

def bump_rev():
    n = current_rev() + 1
    os.makedirs(os.path.join(STORAGE_ROOT, str(n)), exist_ok=False)
    write_head(n)
    return n

def safe_path(sub: str) -> str:
    # prevent path traversal
    return os.path.normpath(os.path.join(STORAGE_ROOT, sub))

def zip_bytes_to_folder(b64: str, dest: str):
    data = base64.b64decode(b64)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        zf.extractall(dest)

# Endpoints

@app.route("/api/health", methods=["GET"])
def health():
    return "healthy", 200

# --- file-service ---

def build_tree(root_path: str, rel_path: str = "") -> list:
    """
    Recursively build a tree of ApiNode-shaped dicts:
      { name, path, isDirectory, modified, size, children? }
    rel_path is the “key” you’ll pass to the frontend.
    """
    nodes = []
    try:
        with os.scandir(root_path) as it:
            for entry in it:
                node_path = os.path.join(rel_path, entry.name)
                full_path = entry.path
                node = {
                    "name": entry.name,
                    "path": node_path,
                    "isDirectory": entry.is_dir(),
                    "modified": entry.stat().st_mtime,
                    "size": entry.stat().st_size if entry.is_file() else None,
                }
                if entry.is_dir():
                    # recurse into subdirectories
                    node["children"] = build_tree(full_path, node_path)
                nodes.append(node)
    except PermissionError:
        # skip dirs you can’t read
        pass
    # optional: sort directories first, then files, alphabetically
    nodes.sort(key=lambda n: (not n["isDirectory"], n["name"].lower()))
    return nodes

@app.route("/api/fs/list", methods=["GET"])
def fs_list():
    # sub is the client-requested “path” under your base directory
    sub = request.args.get("path", "")
    root = safe_path(sub)        # your existing helper to sanitize paths
    if not os.path.exists(root):
        abort(404)
    tree = build_tree(root, sub)
    return jsonify(tree)

@app.route("/api/fs/save", methods=["POST"])
def fs_save():
    req = request.get_json()
    target = safe_path(req["path"])
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        f.write(req["content"])
    return "", 201

@app.route("/api/fs/read", methods=["GET"])
def fs_read():
    path = request.args.get("path", "")
    file_path = safe_path(path)
    if not os.path.exists(file_path):
        abort(404)
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    return jsonify(content), 200

@app.route("/api/fs/write", methods=["POST"])
def fs_write():
    req = request.get_json()
    target = safe_path(req["path"])
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        f.write(req["content"])
    return "", 201

@app.route("/api/fs/rename", methods=["POST"])
def fs_rename():
    req = request.get_json()
    src = safe_path(req["from"])
    dst = safe_path(req["to"])
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.rename(src, dst)
    return "", 204

@app.route("/api/fs/delete", methods=["POST"])
def fs_delete():
    req = request.get_json()
    target = safe_path(req["path"])
    if os.path.isdir(target):
        shutil.rmtree(target)
    else:
        os.remove(target)
    return "", 204

@app.route("/api/fs/snapshot", methods=["POST"])
def fs_snapshot():
    src = safe_path(str(current_rev()))
    new_rev = bump_rev()
    dst = safe_path(str(new_rev))
    # copy contents of src/ into dst/
    os.makedirs(dst, exist_ok=True)
    for name in os.listdir(src):
        src_item = os.path.join(src, name)
        dst_item = os.path.join(dst, name)
        if os.path.isdir(src_item):
            shutil.copytree(src_item, dst_item)
        else:
            shutil.copy2(src_item, dst_item)
    return jsonify({"id": new_rev})

# --- revision-control ---

@app.route("/api/revisions", methods=["GET"])
def rev_list():
    head = current_rev()
    return jsonify({"latest": head, "list": list(range(head + 1))})

@app.route("/api/revisions", methods=["POST"])
def rev_create():
    req = request.get_json()
    new_rev = bump_rev()
    dst = safe_path(str(new_rev))
    zip_bytes_to_folder(req["zip_b64"], dst)
    return jsonify({"id": new_rev})

@app.route("/api/revisions/file", methods=["GET"])
def rev_file():
    rev = request.args.get("rev", type=int)
    path = request.args.get("path", "")
    file_path = safe_path(f"{rev}/{path}")
    if not os.path.exists(file_path):
        abort(404)
    return send_file(file_path)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=4000, debug=True)

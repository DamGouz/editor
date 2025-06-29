// src/components/DirectorySidebar.tsx
import React, {
  useCallback, useEffect, useRef, useState,
} from 'react';
import {
  Layout, Tree, Select, Spin, Button, Space, Popconfirm,
  message, Modal, Input, Dropdown, Menu, Empty,
} from 'antd';
import {
  PlusOutlined, FolderAddOutlined, EditOutlined, DeleteOutlined,
  SyncOutlined, PlusSquareOutlined, SearchOutlined,
} from '@ant-design/icons';
import axios from 'axios';
import { displayError } from '../helpers/error-message';

const { Sider } = Layout;
const { DirectoryTree } = Tree;
const { Option } = Select;

/* ---------- helper types ---------- */
interface ApiNode      { name:string; path:string; isDirectory:boolean; children?:ApiNode[]; }
interface SearchHit    { path:string; matched:'name'|'content'|string; }   // 🔍 API UPDATE
type     ModalMode     = 'none'|'new-file'|'new-folder'|'rename';

/* ---------- constants ---------- */
const DEFAULT_DECISION_JSON = JSON.stringify(
  { contentType:'application/vnd.gorules.decision', nodes:[], edges:[] }, null, 2,
);

/* ---------- tiny helpers ---------- */
const safeDir     = (p:string)=>p.replace(/\\/g,'/');
const safeBase    = (p:string)=>safeDir(p).split('/').pop() ?? p;
const safeDirname = (p:string)=>safeDir(p).split('/').slice(0,-1).join('/');

/* ---------- component ---------- */
export const DirectorySidebar:React.FC<{width?:number; onSelect?:(p:string)=>void;}>
=({ width = 400, onSelect })=>{
  /* revision */
  const [revisions,setRevisions]=useState<number[]>([]);
  const [latest,setLatest]    =useState<number>();
  const [revId,setRevId]      =useState<number>();

  /* tree (full + filtered) */
  const [treeData,setTreeData]
    =useState<React.ComponentProps<typeof DirectoryTree>['treeData']>([]);
  const fullTreeRef = useRef<typeof treeData>([]);                    // 🔍 hold unfiltered tree
  const [loading,setLoading]   =useState(false);

  /* selection */
  const [selKey,setSelKey]     =useState<string>();
  const [selLeaf,setSelLeaf]   =useState<boolean>();
  const selRef      = useRef<string>();
  const menuKeyRef  = useRef<string>();
  const menuLeafRef = useRef<boolean>();

  /* modal & spinner */
  const [modalMode,setModalMode]=useState<ModalMode>('none');
  const [modalVal,setModalVal]  =useState('');
  const [pending,setPending]    =useState(false);   // used by snapshot & modal

  /* ---------- 🔎 SEARCH state ---------- */
  const [searchTerm,setSearchTerm] = useState('');
  const [searching,setSearching]   = useState(false);
  const searchTimeoutRef           = useRef<number>(); // window.setTimeout id

  /* strip helper */
  const stripRev=(p:string)=>p===String(revId)
    ? '' : p.replace(new RegExp(`^${revId}/`),'');

  /* format tree */
  const formatTree=useCallback((nodes:any[]):any[]=>
    nodes.map((n:any)=>({
      title: n.title ?? n.name ?? safeBase(n.path ?? n.key),
      key:   n.key   ?? n.path,
      isLeaf: typeof n.isLeaf==='boolean'
        ? n.isLeaf
        : typeof n.isDirectory==='boolean'
          ? !n.isDirectory
          : !n.children?.length,
      children: n.children ? formatTree(n.children) : undefined,
    })),[]);

  /* ---------- 🔎 build minimal tree from hits ---------- */
  const buildFilteredTree = useCallback((hits:SearchHit[])=>{
    const rootKey = String(revId);
    type Node = { title:React.ReactNode; key:string; isLeaf:boolean; children?:Node[] };

    const root:Node = { title:'/', key:rootKey, isLeaf:false, children:[] };
    const map       = new Map<string,Node>([[rootKey,root]]);
    const matchKind = new Map<string,string>();                    // path -> 'name' | 'content'
    hits.forEach(h=>matchKind.set(h.path,h.matched));

    const ensureDir=(dir:string)=>{
      if(map.has(dir)) return map.get(dir)!;
      const parentDir=safeDirname(dir)||rootKey;
      const node:Node = { title:safeBase(dir)||'/', key:dir, isLeaf:false, children:[] };
      const parent    = ensureDir(parentDir);
      parent.children!.push(node);
      map.set(dir,node);
      return node;
    };

    hits.forEach(hit=>{
      const matched = matchKind.get(hit.path);
      const fileNode:Node = {
        key  : hit.path,
        isLeaf:true,
        title: (
          <span style={matched==='content'?{fontStyle:'italic'}:undefined}>
            {safeBase(hit.path)} <SearchOutlined style={{fontSize:12,marginLeft:4}}/>
          </span>
        ),
      };
      const parentDir=safeDirname(hit.path)||rootKey;
      const parent   = ensureDir(parentDir);
      parent.children!.push(fileNode);
    });

    return [root];
  },[revId]);

  /* ---------- API calls ---------- */
  const fetchRevs=useCallback(async()=>{
    const {data}=await axios.get<{latest:number;list:number[]}>('/api/revisions');
    setRevisions(data.list); setLatest(data.latest);
    setRevId(v=>v??data.latest);
  },[]);

  const fetchTree=useCallback(async(id:number)=>{
    setLoading(true);
    try{
      const {data}=await axios.get<ApiNode[]>(`/api/fs/list?path=${id}`);
      const formatted = formatTree([{title:'/',key:String(id),isLeaf:false,children:data}]);
      fullTreeRef.current = formatted;          // 🔍 store full version
      setTreeData(formatted);
    }finally{setLoading(false);}
  },[formatTree]);

  /* selection helper */
  const setSelection=(k?:string,l?:boolean)=>{ setSelKey(k); setSelLeaf(l); selRef.current=k; };

  /* directory for new */
  const baseDir=()=> menuKeyRef.current
    ? (menuLeafRef.current?safeDirname(menuKeyRef.current):menuKeyRef.current)
    : selRef.current
      ? (selLeaf?safeDirname(selRef.current):selRef.current)
      : String(revId);

  const finish=async(msg:string)=>{ message.success(msg); await fetchTree(revId!); };

  /* CRUD */
  const createItem=async(kind:'file'|'folder',name:string)=>{
    const dir=baseDir();
    if(kind==='folder')
      await axios.post('/api/fs/mkdir',{path:`${dir}/${name}`});
    else
      await axios.post('/api/fs/write',{path:`${dir}/${name}`,content:DEFAULT_DECISION_JSON});
    await finish(kind==='folder'?'Folder created':'File created');
  };

  const renameItem=async(newNameRaw:string)=>{
    const fromRaw=selRef.current; if(!fromRaw||fromRaw===String(revId)){message.warning('Cannot rename root');return;}
    const fromAbs=safeDir(fromRaw);
    const newName=safeBase(newNameRaw);
    const toAbs=`${revId}/${safeDirname(stripRev(fromAbs))}/${newName}`.replace(/\/+/g,'/');
    await axios.post('/api/fs/rename',{from:fromAbs,to:toAbs});
    await finish('Renamed'); setSelection(toAbs,selLeaf);
  };

  const deleteItem=async()=>{
    const k=selRef.current; if(!k||k===String(revId)){message.warning('Cannot delete root');return;}
    await axios.post('/api/fs/delete',{path:k});
    setSelection(); await finish('Deleted');
  };

  /* snapshot */
  const snapshot=async()=>{
    setPending(true);
    try{
      const {data}=await axios.post<{id:number}>('/api/fs/snapshot');
      message.success(`Snapshot rev ${data.id}`);
      await fetchRevs(); setRevId(data.id);
    }finally{setPending(false);}
  };

  /* modal */
  const openModal=(m:ModalMode,def='')=>{setModalMode(m);setModalVal(def);};
  const confirmModal=async()=>{
    const v=modalVal.trim(); if(!v){message.warning('Name required');return;}
    setPending(true);
    try{
      if(modalMode==='new-file')      await createItem('file',v);
      else if(modalMode==='new-folder')await createItem('folder',v);
      else if(modalMode==='rename')   await renameItem(v);
    }catch(e){displayError(e);}finally{setPending(false);setModalMode('none');}
  };

  /* ---------- effects ---------- */
  useEffect(()=>{fetchRevs();},[fetchRevs]);
  useEffect(()=>{if(revId!==undefined)fetchTree(revId);},[revId,fetchTree]);

  /* ---------- 🔎 SEARCH: debounce & query ---------- */
  useEffect(()=>{
    if(searchTimeoutRef.current) window.clearTimeout(searchTimeoutRef.current);

    if(!searchTerm.trim()){          // cleared => restore
      setTreeData(fullTreeRef.current || []);
      setSearching(false);
      return;
    }

    setSearching(true);
    searchTimeoutRef.current = window.setTimeout(async ()=>{
      if(revId===undefined){ setSearching(false); return; }
      try{
        const {data} = await axios.get<SearchHit[]>(
          `/api/fs/search?path=${revId}&q=${encodeURIComponent(searchTerm)}`,
        );
        setTreeData(buildFilteredTree(data));
      }catch(err){ displayError(err); }
      finally   { setSearching(false); }
    },300);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[searchTerm,revId]);   // omit buildFilteredTree on purpose

  /* context menu */
  const rootSel=selRef.current===String(revId);
  const modOK  =selRef.current && !rootSel;

  const menu=(
    <Menu onClick={({key})=>{
      if((key==='rename'||key==='delete')&&!modOK){
        message.warning(rootSel?'Root cannot be modified':'Select an item first');return;
      }
      if(key==='new-file')   openModal('new-file');
      if(key==='new-folder') openModal('new-folder');
      if(key==='rename')     openModal('rename',safeBase(selRef.current!));
      if(key==='delete')     deleteItem();
    }}>
      <Menu.Item key="new-file"   icon={<PlusSquareOutlined/>}>New File</Menu.Item>
      <Menu.Item key="new-folder" icon={<FolderAddOutlined/>}>New Folder</Menu.Item>
      <Menu.Item key="rename"     icon={<EditOutlined/>}  disabled={!modOK}>Rename</Menu.Item>
      <Menu.Item key="delete"     icon={<DeleteOutlined/>} danger disabled={!modOK}>Delete</Menu.Item>
    </Menu>
  );

  /* ---------- render ---------- */
  return (
    <Sider width={width} style={{
      overflow:'auto',background:'inherit',borderRight:'1px solid #f0f0f0',
      padding:8,display:'flex',flexDirection:'column'}}>
      {/* toolbar */}
      <Space style={{marginBottom:8,width:'100%'}}>
        <Select size="small" style={{flex:1}} value={revId} onChange={setRevId}>
          {[...revisions].reverse().map(id=>(
            <Option key={id} value={id}>{id===latest?`HEAD (${id})`:`rev ${id}`}</Option>
          ))}
        </Select>
        <Button
          icon={<SyncOutlined/>}
          size="small"
          onClick={async ()=>{
            await fetchRevs();
            const id = revId ?? latest;
            if(id!==undefined) await fetchTree(id);
          }}
        />
        <Popconfirm title="Create new revision?" onConfirm={snapshot}>
          <Button icon={<PlusOutlined/>} size="small" loading={pending}/>
        </Popconfirm>
      </Space>

      {/* 🔎 search bar */}
      <Input
        placeholder="Search files or contents…"
        size="small"
        allowClear
        prefix={<SearchOutlined/>}
        value={searchTerm}
        onChange={e=>setSearchTerm(e.target.value)}
        onKeyDown={e=>{ if(e.key==='Escape') setSearchTerm(''); }}
        style={{marginBottom:8}}
      />

      <Dropdown overlay={menu} trigger={['contextMenu']} disabled={revId===undefined}>
        <div style={{flex:1}} onContextMenu={e=>{
          if(!(e.target as HTMLElement).closest('.ant-tree-node')){
            menuKeyRef.current=undefined; menuLeafRef.current=undefined;
          }
        }}>
          {loading || searching
            ? <Spin style={{width:'100%',marginTop:32}}/>
            : treeData?.length
              ? (
                <DirectoryTree
                  multiple={false}
                  defaultExpandAll
                  draggable
                  treeData={treeData}
                  selectedKeys={selKey?[selKey]:[]}
                  onSelect={(k,i)=>{
                    const key=k[0] as string;
                    setSelection(key,i.node.isLeaf);
                    if(i.node.isLeaf && onSelect) onSelect(key);
                  }}
                  onRightClick={({node})=>{
                    setSelection(node.key as string,node.isLeaf);
                    menuKeyRef.current=node.key as string;
                    menuLeafRef.current=node.isLeaf;
                  }}
                  onDrop={async info=>{
                    const fromAbs=safeDir(info.dragNode.key as string);
                    const dropAbs=safeDir(info.node.isLeaf
                      ? safeDirname(info.node.key as string)
                      : info.node.key as string);
                    const toAbs=`${revId}/${stripRev(dropAbs)}/${safeBase(fromAbs)}`.replace(/\/+/g,'/');
                    if(fromAbs===toAbs)return;
                    try{
                      await axios.post('/api/fs/rename',{from:fromAbs,to:toAbs});
                      await finish('Moved');
                      setSelection(toAbs,info.dragNode.isLeaf);
                    }catch(err){displayError(err);}
                  }}
                  style={{flex:1}}/>
              )
              : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{marginTop:32}}/>
          }
        </div>
      </Dropdown>

      {/* modal */}
      <Modal
        title={
          modalMode==='rename'? 'Rename'
          :modalMode==='new-file'? 'New File'
          :'New Folder'}
        open={modalMode!=='none'}
        onOk={confirmModal}
        onCancel={()=>setModalMode('none')}
        confirmLoading={pending}
        destroyOnClose>
        <Input
          autoFocus
          value={modalVal}
          onChange={e=>setModalVal(e.target.value)}
          onPressEnter={confirmModal}
        />
      </Modal>
    </Sider>
  );
};

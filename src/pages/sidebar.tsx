// src/components/DirectorySidebar.tsx
import React, { useEffect, useState } from 'react';
import { Layout, Tree } from 'antd';
import axios from 'axios';
import { displayError } from '../helpers/error-message';

const { Sider } = Layout;
const { DirectoryTree } = Tree;

interface ApiNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ApiNode[];
}

export const DirectorySidebar: React.FC<{
  width?: number;
  onSelect?: (path: string) => void;
}> = ({ width = 240, onSelect }) => {
  const [treeData, setTreeData] = useState<React.ComponentProps<typeof DirectoryTree>['treeData']>([]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await axios.get<ApiNode[]>('api/fs/list?path=2');
        setTreeData(formatTreeData(data));
      } catch (err) {
        displayError(err);
      }
    })();
  }, []);

  const formatTreeData = (nodes: ApiNode[]): any[] =>
    nodes.map(node => ({
      title: node.name,
      key: node.path,
      isLeaf: !node.isDirectory,
      children: node.isDirectory && node.children
        ? formatTreeData(node.children)
        : undefined,
    }));

  return (
    <Sider
      width={width}
      style={{ overflow: 'auto', background: 'inherit', borderRight: '1px solid #f0f0f0' }}
    >
      <DirectoryTree
        multiple={false}
        defaultExpandAll
        treeData={treeData}
        onSelect={(keys, info) => {
          if (info.node.isLeaf && keys.length && onSelect) {
            onSelect(keys[0] as string);
          }
        }}
      />
    </Sider>
  );
};

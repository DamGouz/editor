import React, { useRef, useState } from 'react';
import {
  Layout, Tabs, Button, Space, Dropdown, Modal, message, theme, Tooltip,
} from 'antd';
import {
  BulbOutlined, CheckOutlined, PlayCircleOutlined, SaveOutlined,
} from '@ant-design/icons';

import {
  DecisionGraph, DecisionGraphRef, GraphSimulator, Simulation,
} from '@gorules/jdm-editor';
import { DirectedGraph } from 'graphology';
import { hasCycle } from 'graphology-dag';
import axios from 'axios';

import { PageHeader } from '../components/page-header';
import { DirectorySidebar } from './sidebar';
import { displayError } from '../helpers/error-message';
import classes from './decision-simple.module.css';
import { DecisionGraphType } from '@gorules/jdm-editor';
import { ThemePreference, useTheme } from '../context/theme.provider';

enum ContentType { Decision = 'application/vnd.gorules.decision' }

/* ---------- tab model ---------- */
interface TabData {
  key: string;
  title: string;
  filePath?: string;
  graph: DecisionGraphType;
  trace?: Simulation;
  dirty?: boolean;
}

export const DecisionSimplePage: React.FC = () => {
  const { token } = theme.useToken();
  const { themePreference, setThemePreference } = useTheme();
  const graphRef = useRef<DecisionGraphRef>(null);

  const [tabs, setTabs]   = useState<TabData[]>([]);
  const [activeKey, setActive] = useState<string>();

  const activeTab  = tabs.find(t => t.key === activeKey);
  const graph      = activeTab?.graph ?? { nodes: [], edges: [] };
  const filePath   = activeTab?.filePath;
  const fileTitle  = activeTab?.title ?? '';

  /* helpers ------------------------------------------------------- */
  const updateActive = (patch: Partial<TabData>) =>
    setTabs(prev => prev.map(t => (t.key === activeKey ? { ...t, ...patch } : t)));

  const addTab = (tab: TabData) => { setTabs(p => [...p, tab]); setActive(tab.key); };

  const closeTab = (k: string) => setTabs(prev => prev.filter(t => t.key !== k));

  /* sidebar file open -------------------------------------------- */
  const handleFileSelect = async (path: string) => {
    const existing = tabs.find(t => t.filePath === path);
    if (existing) { setActive(existing.key); return; }

    try {
      const { data } = await axios.get(`/api/fs/read?path=${encodeURIComponent(path)}`);
      const parsed = JSON.parse(data);
      if (parsed.contentType !== ContentType.Decision) throw new Error('Invalid type');

      addTab({
        key: crypto.randomUUID(),
        title: path.split('/').pop() || 'decision',
        filePath: path,
        graph: { nodes: parsed.nodes || [], edges: parsed.edges || [] },
        dirty: false,
      });
    } catch (e) { displayError(e); }
  };

  /* save ---------------------------------------------------------- */
  const ensureAcyclic = (dc: DecisionGraphType = graph) => {
    const g = new DirectedGraph();
    (dc.edges || []).forEach(e => g.mergeEdge(e.sourceId, e.targetId));
    if (hasCycle(g)) throw new Error('Circular dependencies detected');
  };

  const saveToServer = async () => {
    if (!activeTab) return;
    try {
      ensureAcyclic();
      const json = JSON.stringify({ contentType: ContentType.Decision, ...graph }, null, 2);
      await axios.post('/api/fs/write', {
        path: (filePath ?? fileTitle) || 'decision.json',
        content: json,
      });
      updateActive({ dirty: false });
      message.success('File saved');
    } catch (e) { displayError(e); }
  };

  /* ui helpers ---------------------------------------------------- */
  const tabLabel = (t: TabData) => (t.dirty ? `${t.title} *` : t.title);

  const headerTitle = (t: TabData) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {t.dirty ? `${t.title} *` : t.title}
      <Tooltip title="Save">
        <Button
          type="text"
          icon={<SaveOutlined style={{ fontSize: 18 }} />}
          onClick={saveToServer}
        />
      </Tooltip>
    </span>
  );

  /* -------------------------------------------------------------- */
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <DirectorySidebar onSelect={handleFileSelect} />

      <div className={classes.tabsContainer}>
        {tabs.length ? (
          <Tabs
            type="editable-card"
            activeKey={activeKey}
            onChange={setActive}
            hideAdd
            onEdit={(k, action) => {
              if (action !== 'remove') return;
              const tab = tabs.find(t => t.key === k); if (!tab) return;
              if (tab.dirty) {
                Modal.confirm({
                  title: `Close “${tab.title}” without saving?`,
                  content: 'Your latest changes will be lost.',
                  okType: 'danger',
                  okText: 'Close anyway',
                  cancelText: 'Cancel',
                  onOk: () => closeTab(k as string),
                });
              } else closeTab(k as string);
            }}
            items={tabs.map(t => ({
              key: t.key,
              label: tabLabel(t),
              children: (
                <div className={classes.tabContent}>
                  <PageHeader
                    style={{
                      padding: 8,
                      background: token.colorBgLayout,
                      borderBottom: `1px solid ${token.colorBorder}`,
                    }}
                    title={headerTitle(t)}
                    ghost={false}
                    extra={
                      <Dropdown
                        menu={{
                          onClick: ({ key }) => setThemePreference(key as ThemePreference),
                          items: [
                            { label:'Automatic', key:ThemePreference.Automatic,
                              icon:<CheckOutlined style={{visibility:themePreference===ThemePreference.Automatic?'visible':'hidden'}}/> },
                            { label:'Dark', key:ThemePreference.Dark,
                              icon:<CheckOutlined style={{visibility:themePreference===ThemePreference.Dark?'visible':'hidden'}}/> },
                            { label:'Light', key:ThemePreference.Light,
                              icon:<CheckOutlined style={{visibility:themePreference===ThemePreference.Light?'visible':'hidden'}}/> },
                          ],
                        }}
                      >
                        <Button type="text" icon={<BulbOutlined />} />
                      </Dropdown>
                    }
                  />

                  <div className={classes.graphArea} style={{ width: '100%', height: '100%' }}>
                    <DecisionGraph
                      ref={graphRef}
                      value={t.graph}
                      onChange={(g: DecisionGraphType) => updateActive({ graph: g, dirty: true })}
                      reactFlowProOptions={{ hideAttribution: true }}
                      simulate={t.trace}
                      panels={[
                        {
                          id: 'sim',
                          title: 'Simulator',
                          icon: <PlayCircleOutlined />,
                          renderPanel: () => (
                            <GraphSimulator
                              onClear={() => updateActive({ trace: undefined })}
                              onRun={async ({ graph, context }) => {
                                try {
                                  const { data } = await axios.post('/api/simulate', { content: graph, context });
                                  updateActive({ trace: { result: data } });
                                } catch (e) { displayError(e); }
                              }}
                              // @ts-ignore  (adjust to the actual callback name your library provides)
                              onContextChange={() => updateActive({ dirty: true })}
                            />
                          ),
                        },
                      ]}
                    />
                  </div>
                </div>
              ),
            }))}
          />
        ) : (
          <div className={classes.placeholder}>
            <span>Select a file from the sidebar to begin</span>
          </div>
        )}
      </div>
    </Layout>
  );
};

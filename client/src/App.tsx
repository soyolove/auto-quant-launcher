import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { listTemplates, listWorkspaces, type TemplateInfo, type Workspace } from './api';
import { Sidebar } from './Sidebar';
import type { KeyMap } from './Terminal';
import { WorkspaceView } from './WorkspaceView';
import './App.css';

/**
 * Consumer-side key map. Architecturally equivalent to a user's VSCode
 * `keybindings.json` after running Claude Code's `/terminal-setup`.
 */
const APP_KEY_MAP: KeyMap = {
  'shift+enter': '\x1b\r',
};

const LIST_POLL_MS = 5000;
const HASH_PREFIX = '#/w/';

function readSelectedFromHash(): string | null {
  const h = window.location.hash;
  if (h.startsWith(HASH_PREFIX)) {
    const id = h.slice(HASH_PREFIX.length);
    return id.length > 0 ? id : null;
  }
  return null;
}

function writeSelectedToHash(id: string | null): void {
  const target = id ? `${HASH_PREFIX}${id}` : '';
  if (window.location.hash === target) return;
  if (target) {
    window.history.replaceState(null, '', target);
  } else {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

export function App(): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(readSelectedFromHash());
  /**
   * Per-attach resume intent, transient. Tied to `selectedId` (matching pair).
   * Set to `'last'` when the user explicitly clicks the "↻ continue" button;
   * cleared on any other selection change. Forms part of the `WorkspaceView`
   * key so toggling it forces a remount + fresh WS attach.
   */
  const [resumeIntent, setResumeIntent] = useState<'last' | string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const list = await listWorkspaces();
      setWorkspaces(list);
      setListError(null);
    } catch (err) {
      setListError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), LIST_POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Templates don't change at runtime; fetch once on mount.
    void listTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  useEffect(() => {
    const onHashChange = (): void => {
      setSelectedId(readSelectedFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const select = (id: string, resume: 'last' | string | null = null): void => {
    const next = id.length > 0 ? id : null;
    writeSelectedToHash(next);
    setSelectedId(next);
    setResumeIntent(resume);
  };

  const selected = selectedId ? workspaces.find((w) => w.id === selectedId) : undefined;

  return (
    <main className="app">
      <Sidebar
        workspaces={workspaces}
        templates={templates}
        listError={listError}
        selectedId={selectedId}
        onSelect={(id) => select(id, null)}
        onContinue={(id) => select(id, 'last')}
        onChanged={() => void refresh()}
      />
      <section className="main-pane">
        {selectedId ? (
          <WorkspaceView
            key={`${selectedId}:${resumeIntent ?? 'attach'}`}
            wsId={selectedId}
            label={selected?.tag ?? selectedId}
            keyMap={APP_KEY_MAP}
            {...(resumeIntent !== null ? { resume: resumeIntent } : {})}
          />
        ) : (
          <div className="empty-pane">
            <h2>auto-quant launcher</h2>
            <p>Select a workspace from the sidebar, or create one with the form above.</p>
          </div>
        )}
      </section>
    </main>
  );
}

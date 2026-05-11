import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

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

  useEffect(() => {
    const onHashChange = (): void => {
      setSelectedId(readSelectedFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const select = (id: string): void => {
    const next = id.length > 0 ? id : null;
    writeSelectedToHash(next);
    setSelectedId(next);
  };

  return (
    <main className="app">
      <Sidebar selectedId={selectedId} onSelect={select} />
      <section className="main-pane">
        {selectedId ? (
          <WorkspaceView key={selectedId} wsId={selectedId} keyMap={APP_KEY_MAP} />
        ) : (
          <div className="empty-pane">
            <h2>web-terminal</h2>
            <p>Select a workspace from the sidebar, or create one with the form above.</p>
          </div>
        )}
      </section>
    </main>
  );
}

import type { ReactElement } from 'react';

import { TerminalView, type KeyMap } from './Terminal';
import './App.css';

/**
 * Consumer-side key map. Architecturally equivalent to a user's VSCode
 * `keybindings.json` after running Claude Code's `/terminal-setup`.
 *
 * The `TerminalView` component itself ships no default mapping — that's
 * deliberate, because hardcoding app-specific bytes inside a generic terminal
 * breaks neutral apps (bash readline would see ESC+CR as Meta+Enter, etc.).
 * If you don't want this mapping, pass `keyMap={{}}` (or just drop the prop).
 */
const APP_KEY_MAP: KeyMap = {
  // Claude Code / Codex / Cursor agent multiline: same encoding the iTerm2
  // Claude Code preset installs ("Send Escape Sequence: \r" on Shift+Enter).
  'shift+enter': '\x1b\r',
};

export function App(): ReactElement {
  return (
    <main className="app">
      <TerminalView keyMap={APP_KEY_MAP} />
    </main>
  );
}

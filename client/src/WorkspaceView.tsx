import type { ReactElement } from 'react';

import { FilesPanel } from './FilesPanel';
import { GitPanel } from './GitPanel';
import { TerminalView, type KeyMap } from './Terminal';

export interface WorkspaceViewProps {
  readonly wsId: string;
  readonly keyMap?: KeyMap;
}

export function WorkspaceView(props: WorkspaceViewProps): ReactElement {
  const terminalProps = props.keyMap
    ? { wsId: props.wsId, keyMap: props.keyMap }
    : { wsId: props.wsId };
  return (
    <div className="workspace-view">
      <div className="workspace-terminal">
        <TerminalView {...terminalProps} />
      </div>
      <aside className="workspace-side">
        <GitPanel wsId={props.wsId} />
        <FilesPanel wsId={props.wsId} />
      </aside>
    </div>
  );
}

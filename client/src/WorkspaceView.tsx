import type { ReactElement } from 'react';

import { FilesPanel } from './FilesPanel';
import { GitPanel } from './GitPanel';
import { TerminalView, type KeyMap, type TerminalViewProps } from './Terminal';

export interface WorkspaceViewProps {
  readonly wsId: string;
  readonly label?: string;
  readonly keyMap?: KeyMap;
  readonly resume?: 'last' | string;
}

export function WorkspaceView(props: WorkspaceViewProps): ReactElement {
  // Avoid passing `undefined` for exactOptionalPropertyTypes-clean props.
  const terminalProps: TerminalViewProps = {
    wsId: props.wsId,
    ...(props.label !== undefined ? { label: props.label } : {}),
    ...(props.keyMap !== undefined ? { keyMap: props.keyMap } : {}),
    ...(props.resume !== undefined ? { resume: props.resume } : {}),
  };

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

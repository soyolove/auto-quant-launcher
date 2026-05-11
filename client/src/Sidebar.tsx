import { useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { createWorkspace, deleteWorkspace, type Workspace } from './api';

const TAG_HINT = 'a-z, 0-9, "-", "_", up to 33 chars';
const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,32}$/;

export interface SidebarProps {
  readonly workspaces: readonly Workspace[];
  readonly listError: string | null;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /** Called after a successful create or delete so the parent can refetch. */
  readonly onChanged: () => void;
}

export function Sidebar(props: SidebarProps): ReactElement {
  const [creating, setCreating] = useState(false);
  const [tag, setTag] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const t = tag.trim();
    if (!TAG_RE.test(t)) {
      setCreateError(`invalid tag (${TAG_HINT})`);
      return;
    }
    setCreating(true);
    setCreateError(null);
    const result = await createWorkspace(t);
    setCreating(false);
    if (result.ok) {
      setTag('');
      props.onChanged();
      props.onSelect(result.workspace.id);
    } else {
      const msg =
        result.error.message ??
        result.error.error ??
        `HTTP ${result.status}`;
      setCreateError(msg);
    }
  };

  const onDelete = async (id: string): Promise<void> => {
    if (!window.confirm('Delete workspace? (registry only — files on disk are kept.)')) return;
    const ok = await deleteWorkspace(id);
    if (ok) {
      props.onChanged();
      if (props.selectedId === id) props.onSelect('');
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Workspaces</span>
        <button
          type="button"
          className="sidebar-new-btn"
          onClick={() => inputRef.current?.focus()}
          aria-label="New workspace"
        >
          +
        </button>
      </div>

      <form className="sidebar-create" onSubmit={submit}>
        <input
          ref={inputRef}
          type="text"
          placeholder="tag (e.g. may1)"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          disabled={creating}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <button type="submit" disabled={creating || tag.length === 0}>
          {creating ? '…' : 'create'}
        </button>
      </form>
      {createError && <div className="sidebar-error">{createError}</div>}

      <ul className="sidebar-list">
        {props.workspaces.length === 0 && !props.listError && (
          <li className="sidebar-empty">no workspaces yet</li>
        )}
        {props.listError && <li className="sidebar-error">{props.listError}</li>}
        {props.workspaces.map((w) => (
          <li
            key={w.id}
            className={`sidebar-row ${w.id === props.selectedId ? 'is-selected' : ''}`}
          >
            <button
              type="button"
              className="sidebar-row-main"
              onClick={() => props.onSelect(w.id)}
            >
              <span
                className="sidebar-status-dot"
                style={{ background: w.claudeRunning ? '#7ee787' : '#6e7681' }}
                title={w.claudeRunning ? 'agent running' : 'idle'}
              />
              <span className="sidebar-tag">{w.tag}</span>
              <span className="sidebar-meta">{relativeTime(w.createdAt)}</span>
            </button>
            <button
              type="button"
              className="sidebar-delete"
              title="delete"
              onClick={() => void onDelete(w.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const dMs = Date.now() - t;
  if (dMs < 60_000) return 'just now';
  if (dMs < 3_600_000) return `${Math.floor(dMs / 60_000)}m`;
  if (dMs < 86_400_000) return `${Math.floor(dMs / 3_600_000)}h`;
  return `${Math.floor(dMs / 86_400_000)}d`;
}

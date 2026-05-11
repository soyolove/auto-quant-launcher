import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { getGitLog, getGitStatus, type GitLogEntry, type GitStatus } from './api';

const POLL_MS = 3000;
const LOG_LIMIT = 30;

interface GitPanelProps {
  readonly wsId: string;
}

export function GitPanel(props: GitPanelProps): ReactElement {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStatus(null);
    setEntries([]);
    setError(null);

    const refresh = async (): Promise<void> => {
      try {
        const [s, l] = await Promise.all([
          getGitStatus(props.wsId),
          getGitLog(props.wsId, LOG_LIMIT),
        ]);
        if (!alive) return;
        setStatus(s);
        setEntries(l);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError((err as Error).message);
      }
    };

    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [props.wsId]);

  return (
    <section className="panel git-panel">
      <header className="panel-header">
        <span className="panel-title">git</span>
        {status?.branch && <span className="panel-pill">{status.branch}</span>}
        {status?.clean === false && <span className="panel-pill panel-pill-dirty">{status.files.length} changed</span>}
      </header>

      {error && <div className="panel-error">{error}</div>}

      {status && status.files.length > 0 && (
        <ul className="git-status-list">
          {status.files.map((f) => (
            <li key={f.path} className="git-status-row">
              <span className="git-status-code">{renderStatus(f.status)}</span>
              <span className="git-status-path">{f.path}</span>
            </li>
          ))}
        </ul>
      )}

      <ul className="git-log-list">
        {entries.length === 0 && !error && (
          <li className="panel-empty">no commits yet</li>
        )}
        {entries.map((e) => (
          <li key={e.hash} className="git-log-row" title={e.authorTime}>
            <span className="git-log-hash">{e.hash}</span>
            <span className="git-log-time">{e.relTime}</span>
            <span className="git-log-subject">{e.subject}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function renderStatus(s: string): string {
  // Compact rendering of the porcelain 2-char code. We surface the meaningful
  // letter; trailing/leading space becomes a dot for visibility.
  return s.replace(/ /g, '·');
}

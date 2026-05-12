/**
 * Thin fetch wrapper for /api/workspaces*. Types mirror the server's
 * `WorkspaceMeta` (plus a synthetic `claudeRunning` field derived by the
 * server from the SessionPool).
 */

export interface Workspace {
  readonly id: string;
  readonly tag: string;
  readonly dir: string;
  readonly createdAt: string;
  readonly claudeRunning: boolean;
  readonly template?: string;
  /** Count of Claude Code session transcripts on disk for this workspace. */
  readonly sessionCount: number;
}

export interface CreateError {
  readonly error:
    | 'invalid_tag'
    | 'tag_in_use'
    | 'tag_required'
    | 'bootstrap_failed'
    | 'unknown_template'
    | 'no_templates_configured';
  readonly message?: string;
  readonly stderr?: string;
}

export type CreateResult =
  | { readonly ok: true; readonly workspace: Workspace }
  | { readonly ok: false; readonly status: number; readonly error: CreateError };

export async function listWorkspaces(): Promise<Workspace[]> {
  const res = await fetch('/api/workspaces');
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  const body = (await res.json()) as { workspaces: Workspace[] };
  return body.workspaces;
}

export async function createWorkspace(tag: string, template: string): Promise<CreateResult> {
  const res = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag, template }),
  });
  if (res.ok) {
    const body = (await res.json()) as { workspace: Workspace };
    return { ok: true, workspace: body.workspace };
  }
  let err: CreateError;
  try {
    err = (await res.json()) as CreateError;
  } catch {
    err = { error: 'bootstrap_failed', message: `HTTP ${res.status}` };
  }
  return { ok: false, status: res.status, error: err };
}

export interface TemplateInfo {
  readonly name: string;
  readonly description?: string;
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  const res = await fetch('/api/templates');
  if (!res.ok) throw new Error(`list templates failed: ${res.status}`);
  const body = (await res.json()) as { templates: TemplateInfo[] };
  return body.templates;
}

// ── sessions (Claude Code transcripts on disk) ───────────────────────────────

export interface SessionMeta {
  readonly sessionId: string;
  readonly file: string;
  readonly mtime: string;
  readonly sizeBytes: number;
}

export async function listSessions(id: string): Promise<SessionMeta[]> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}/sessions`);
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
  const body = (await res.json()) as { sessions: SessionMeta[] };
  return body.sessions;
}

export async function deleteWorkspace(id: string): Promise<boolean> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return res.ok;
}

// ── git ──────────────────────────────────────────────────────────────────────

export interface GitLogEntry {
  readonly hash: string;
  readonly subject: string;
  readonly relTime: string;
  readonly authorTime: string;
}

export interface GitStatusFile {
  readonly path: string;
  readonly status: string;
}

export interface GitStatus {
  readonly branch: string | null;
  readonly clean: boolean;
  readonly files: readonly GitStatusFile[];
}

export async function getGitLog(id: string, limit = 30): Promise<GitLogEntry[]> {
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(id)}/git/log?limit=${limit}`,
  );
  if (!res.ok) throw new Error(`git log failed: ${res.status}`);
  const body = (await res.json()) as { entries: GitLogEntry[] };
  return body.entries;
}

export async function getGitStatus(id: string): Promise<GitStatus> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}/git/status`);
  if (!res.ok) throw new Error(`git status failed: ${res.status}`);
  return (await res.json()) as GitStatus;
}

// ── files ────────────────────────────────────────────────────────────────────

export interface FileEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'symlink' | 'other';
  readonly sizeBytes: number | null;
  readonly mtime: string;
}

export interface DirListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
}

export async function listFiles(id: string, relPath: string): Promise<DirListing> {
  const qs = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}/files${qs}`);
  if (!res.ok) throw new Error(`list files failed: ${res.status}`);
  return (await res.json()) as DirListing;
}

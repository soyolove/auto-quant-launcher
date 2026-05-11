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
}

export interface CreateError {
  readonly error: 'invalid_tag' | 'tag_in_use' | 'tag_required' | 'bootstrap_failed';
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

export async function createWorkspace(tag: string): Promise<CreateResult> {
  const res = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag }),
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

export async function deleteWorkspace(id: string): Promise<boolean> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return res.ok;
}

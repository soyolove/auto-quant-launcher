import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Discover Claude Code session transcripts that exist on disk for a given
 * workspace directory.
 *
 * Claude Code stores transcripts as JSONL files keyed by the cwd it was
 * launched in:
 *
 *   ~/.claude/projects/<dashed-cwd>/<sessionId>.jsonl
 *
 * `<dashed-cwd>` is the absolute path with both `/` and `.` characters
 * replaced by `-`. Verified empirically on macOS 25 with Claude Code
 * v2.1.138. The mapping is stable and is what `claude --continue` /
 * `claude --resume <id>` look at.
 *
 * If `~/.claude` ever moves (CLAUDE_HOME env override, different platform
 * path layout), we'd need to consult Claude Code config rather than assume
 * the home-directory path.
 */

export interface SessionMeta {
  readonly sessionId: string;
  /** Absolute path to the `.jsonl` transcript on disk. */
  readonly file: string;
  /** ISO timestamp. */
  readonly mtime: string;
  readonly sizeBytes: number;
}

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface DiscoveryOptions {
  /** Override for `~/.claude/projects` location (testing or non-default homes). */
  readonly projectsDir?: string;
}

export function projectKey(workspaceDir: string): string {
  const abs = resolve(workspaceDir);
  return abs.replaceAll('/', '-').replaceAll('.', '-');
}

export function projectDirFor(
  workspaceDir: string,
  opts: DiscoveryOptions = {},
): string {
  const base = opts.projectsDir ?? join(homedir(), '.claude', 'projects');
  return join(base, projectKey(workspaceDir));
}

/**
 * Cheap variant: count the JSONL files without stat'ing each. Used by
 * `/api/workspaces` to show a sidebar badge without paying the per-file
 * fs.stat cost on every poll.
 */
export async function countSessions(
  workspaceDir: string,
  opts: DiscoveryOptions = {},
): Promise<number> {
  const dir = projectDirFor(workspaceDir, opts);
  if (!existsSync(dir)) return 0;
  const entries = await readdir(dir);
  return entries.filter((n) => SESSION_FILE_RE.test(n)).length;
}

export async function discoverSessions(
  workspaceDir: string,
  opts: DiscoveryOptions = {},
): Promise<SessionMeta[]> {
  const dir = projectDirFor(workspaceDir, opts);
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const out: SessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = SESSION_FILE_RE.exec(entry.name);
    if (!match || !match[1]) continue;
    const file = join(dir, entry.name);
    try {
      const s = await stat(file);
      out.push({
        sessionId: match[1],
        file,
        mtime: s.mtime.toISOString(),
        sizeBytes: s.size,
      });
    } catch {
      // race with deletion / permission issue — skip
    }
  }
  // Newest first.
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

import { readdir, stat, lstat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

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

export class PathTraversal extends Error {
  constructor(public readonly attempted: string) {
    super(`refused to escape workspace: ${attempted}`);
    this.name = 'PathTraversal';
  }
}

/**
 * List a single directory inside a workspace.
 *
 * - `relPath` is interpreted relative to `workspaceDir`. Both `''` and `'.'`
 *   mean the workspace root.
 * - Absolute paths, leading `..` segments, and any path that escapes
 *   `workspaceDir` after normalisation throw `PathTraversal`.
 * - Symlinks are reported as symlinks (via `lstat`); their target is NOT
 *   followed, so a malicious symlink can't lead us outside.
 */
export async function listDir(workspaceDir: string, relPath: string): Promise<DirListing> {
  const cleanRel = normalize(relPath || '.');
  if (isAbsolute(cleanRel) || cleanRel === '..' || cleanRel.startsWith(`..${sep}`)) {
    throw new PathTraversal(relPath);
  }
  const abs = resolve(workspaceDir, cleanRel);
  const workspaceAbs = resolve(workspaceDir);
  if (abs !== workspaceAbs && !abs.startsWith(workspaceAbs + sep)) {
    throw new PathTraversal(relPath);
  }

  const dirStat = await stat(abs);
  if (!dirStat.isDirectory()) {
    throw new Error(`not a directory: ${cleanRel}`);
  }

  const names = await readdir(abs);
  const entries: FileEntry[] = [];
  for (const name of names) {
    try {
      const ls = await lstat(resolve(abs, name));
      const kind: FileEntry['kind'] = ls.isSymbolicLink()
        ? 'symlink'
        : ls.isDirectory()
          ? 'dir'
          : ls.isFile()
            ? 'file'
            : 'other';
      entries.push({
        name,
        kind,
        sizeBytes: ls.isFile() ? ls.size : null,
        mtime: ls.mtime.toISOString(),
      });
    } catch {
      // skip entries we can't stat (race with deletion, perm error, etc.)
    }
  }
  entries.sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (a.kind !== 'dir' && b.kind === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  return { path: cleanRel === '.' ? '' : cleanRel, entries };
}

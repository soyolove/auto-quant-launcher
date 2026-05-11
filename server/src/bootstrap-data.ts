import { cp, readdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from './logger.js';

/**
 * On first launcher boot the shared data directory doesn't exist yet.
 * Without it, the bootstrap script would create symlinks pointing at
 * nothing and `prepare.py` inside each workspace would refuse to start.
 *
 * Seed it from the template's `user_data/data/` once, then leave it alone
 * (re-seeding on every boot would clobber any updates `prepare.py` made
 * inside a workspace via the symlink).
 */
export async function ensureSharedData(opts: {
  readonly templateDir: string;
  readonly sharedDataDir: string;
  readonly logger: Logger;
}): Promise<void> {
  const log = opts.logger;
  const seedSource = join(opts.templateDir, 'user_data', 'data');

  // Already populated? Leave it.
  if (existsSync(opts.sharedDataDir)) {
    try {
      const names = await readdir(opts.sharedDataDir);
      if (names.length > 0) {
        log.info('shared_data.skip_existing', {
          dir: opts.sharedDataDir,
          count: names.length,
        });
        return;
      }
    } catch (err) {
      log.warn('shared_data.readdir_failed', { dir: opts.sharedDataDir, err });
    }
  }

  // Source missing? Just note it and continue — the user can populate later.
  let sourceStat;
  try {
    sourceStat = await stat(seedSource);
  } catch {
    log.warn('shared_data.no_template_source', { seedSource });
    return;
  }
  if (!sourceStat.isDirectory()) {
    log.warn('shared_data.template_source_not_dir', { seedSource });
    return;
  }

  mkdirSync(opts.sharedDataDir, { recursive: true });
  log.info('shared_data.seeding', {
    from: seedSource,
    to: opts.sharedDataDir,
  });
  await cp(seedSource, opts.sharedDataDir, { recursive: true });
  const after = await readdir(opts.sharedDataDir);
  log.info('shared_data.seeded', {
    dir: opts.sharedDataDir,
    count: after.length,
  });
}

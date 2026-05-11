import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Logger } from './logger.js';

export interface TemplateMeta {
  readonly name: string;
  readonly description?: string;
  /** Absolute path to the template's `bootstrap.sh`. */
  readonly bootstrapScript: string;
  /** Absolute path to the template's `files/` directory (may not exist). */
  readonly filesDir: string;
}

/**
 * Discovers `server/templates/<name>/bootstrap.sh` directories at startup and
 * exposes them as named templates. Each template *must* have an executable
 * `bootstrap.sh`; everything else (`template.json` for metadata, `files/` for
 * static assets the script copies) is optional.
 *
 * Cached for the server's lifetime — templates don't change at runtime.
 */
export class TemplateRegistry {
  private readonly byName = new Map<string, TemplateMeta>();

  private constructor() {}

  static async load(dir: string, logger: Logger): Promise<TemplateRegistry> {
    const reg = new TemplateRegistry();
    const absDir = resolve(dir);
    if (!existsSync(absDir)) {
      logger.warn('templates.dir_missing', { dir: absDir });
      return reg;
    }
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const templateDir = join(absDir, name);
      const bootstrapScript = join(templateDir, 'bootstrap.sh');
      if (!existsSync(bootstrapScript)) {
        logger.warn('templates.no_bootstrap', { name, templateDir });
        continue;
      }
      const filesDir = join(templateDir, 'files');
      const description = await readDescription(join(templateDir, 'template.json'));
      const meta: TemplateMeta = {
        name,
        ...(description !== undefined ? { description } : {}),
        bootstrapScript,
        filesDir,
      };
      reg.byName.set(name, meta);
    }
    logger.info('templates.loaded', { dir: absDir, names: Array.from(reg.byName.keys()) });
    return reg;
  }

  /**
   * Register a synthetic template at runtime — used for the legacy
   * `AQ_BOOTSTRAP_SCRIPT` fallback so old configurations keep working
   * during the migration window.
   */
  registerSynthetic(meta: TemplateMeta): void {
    this.byName.set(meta.name, meta);
  }

  list(): TemplateMeta[] {
    return Array.from(this.byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): TemplateMeta | undefined {
    return this.byName.get(name);
  }

  /**
   * Name used when a client doesn't specify a template. Prefers `chat`
   * (the new MCP-injection demo) if available, otherwise falls back to the
   * first alphabetical template.
   */
  defaultName(): string | undefined {
    if (this.byName.has('chat')) return 'chat';
    const first = this.list()[0];
    return first?.name;
  }
}

async function readDescription(path: string): Promise<string | undefined> {
  try {
    if (!statSync(path).isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const desc = (parsed as Record<string, unknown>)['description'];
      if (typeof desc === 'string') return desc;
    }
  } catch {
    // ignore malformed template.json
  }
  return undefined;
}

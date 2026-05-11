import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import { ensureSharedData } from './bootstrap-data.js';
import { loadConfig, type ServerConfig } from './config.js';
import { listDir, PathTraversal } from './file-service.js';
import { gitLog, gitStatus } from './git-service.js';
import { logger } from './logger.js';
import { SessionPool } from './session-pool.js';
import { buildSpawnEnv } from './spawn-env.js';
import { TemplateRegistry } from './template-registry.js';
import { WorkspaceCreator } from './workspace-creator.js';
import { WorkspaceRegistry, type WorkspaceMeta } from './workspace-registry.js';

const config = loadConfig();

await ensureSharedData({
  templateDir: config.templateDir,
  sharedDataDir: config.sharedDataDir,
  logger: logger.child({ scope: 'data-bootstrap' }),
});

const registry = await WorkspaceRegistry.load(
  `${config.launcherRoot}/workspaces.json`,
  logger.child({ scope: 'registry' }),
);

const templates = await TemplateRegistry.load(
  config.templatesDir,
  logger.child({ scope: 'templates' }),
);
if (config.legacyBootstrapScript) {
  logger.warn('config.legacy_bootstrap_script', {
    script: config.legacyBootstrapScript,
    note: 'AQ_BOOTSTRAP_SCRIPT is honored as synthetic template `legacy`; migrate by moving the script under AQ_TEMPLATES_DIR/<name>/bootstrap.sh.',
  });
  templates.registerSynthetic({
    name: 'legacy',
    description: 'legacy AQ_BOOTSTRAP_SCRIPT entry — migrate to a real template',
    bootstrapScript: config.legacyBootstrapScript,
    filesDir: '',
  });
}

const creator = new WorkspaceCreator({
  workspacesRoot: `${config.launcherRoot}/workspaces`,
  templateRegistry: templates,
  bootstrapEnv: {
    templateDir: config.templateDir,
    sharedDataDir: config.sharedDataDir,
    launcherRepoRoot: config.launcherRepoRoot,
  },
  bootstrapTimeoutMs: config.bootstrapTimeoutMs,
  registry,
  logger: logger.child({ scope: 'creator' }),
});

const pool = new SessionPool(
  (wsId) => {
    const ws = registry.get(wsId);
    if (!ws) throw new Error(`workspace not found: ${wsId}`);
    return {
      command: config.command,
      cwd: ws.dir,
      env: buildSpawnEnv(process.env, {
        AQ_WS_ID: wsId,
        AQ_LAUNCHER_REPO_ROOT: config.launcherRepoRoot,
      }),
      initialCols: 80,
      initialRows: 24,
      logger: logger.child({ scope: 'session', wsId }),
      replayBufferBytes: config.replayBufferBytes,
      highWatermarkBytes: config.bpHighWatermarkBytes,
      lowWatermarkBytes: config.bpLowWatermarkBytes,
    };
  },
  logger.child({ scope: 'pool' }),
);

let shuttingDown = false;

const http = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    logger.error('http.unhandled', { err });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    } else {
      res.end();
    }
  });
});

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }

  if (path === '/api/templates') {
    if (method === 'GET') {
      return sendJson(res, 200, {
        templates: templates.list().map((t) => ({
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
        })),
      });
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  if (path === '/api/workspaces') {
    if (method === 'GET') {
      return sendJson(res, 200, {
        workspaces: registry.list().map((w) => publicMeta(w)),
      });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const fields = typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
      const tag = fields['tag'];
      if (typeof tag !== 'string') {
        return sendJson(res, 400, { error: 'tag_required' });
      }
      const rawTemplate = fields['template'];
      let templateName: string;
      if (typeof rawTemplate === 'string' && rawTemplate.length > 0) {
        templateName = rawTemplate;
      } else {
        const def = templates.defaultName();
        if (!def) {
          return sendJson(res, 500, {
            error: 'no_templates_configured',
            message: 'no templates discovered; set AQ_TEMPLATES_DIR or AQ_BOOTSTRAP_SCRIPT',
          });
        }
        templateName = def;
      }
      const result = await creator.create(tag, templateName);
      if (!result.ok) {
        const status =
          result.code === 'invalid_tag' ? 400
          : result.code === 'unknown_template' ? 400
          : result.code === 'tag_in_use' ? 409
          : 500;
        return sendJson(res, status, {
          error: result.code,
          message: result.message,
          stderr: 'stderr' in result ? result.stderr.slice(-4000) : undefined,
        });
      }
      return sendJson(res, 201, { workspace: publicMeta(result.workspace) });
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  const idMatch = path.match(/^\/api\/workspaces\/([a-zA-Z0-9_-]+)(\/(?:git\/log|git\/status|files))?$/);
  if (idMatch && idMatch[1]) {
    const id = idMatch[1];
    const sub = idMatch[2] ?? null;
    const meta = registry.get(id);

    if (sub === null) {
      if (method === 'DELETE') {
        const purge = url.searchParams.get('purge') === 'true';
        pool.dispose(id, 'workspace deleted');
        const removed = await registry.remove(id);
        if (!removed) return sendJson(res, 404, { error: 'not_found' });
        let purged = false;
        if (purge) {
          try {
            const { rm } = await import('node:fs/promises');
            await rm(removed.dir, { recursive: true, force: true });
            purged = true;
          } catch (err) {
            logger.error('workspace.purge_failed', { id, dir: removed.dir, err });
          }
        }
        logger.info('workspace.removed', { id, dir: removed.dir, purged });
        return sendJson(res, 200, { ok: true, purged });
      }
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    if (!meta) return sendJson(res, 404, { error: 'not_found' });
    if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });

    if (sub === '/git/log') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '30', 10);
      try {
        const entries = await gitLog(meta.dir, Number.isFinite(limit) ? limit : 30);
        return sendJson(res, 200, { entries });
      } catch (err) {
        logger.warn('git.log_failed', { id, err });
        return sendJson(res, 500, { error: 'git_failed', message: (err as Error).message });
      }
    }
    if (sub === '/git/status') {
      try {
        const status = await gitStatus(meta.dir);
        return sendJson(res, 200, status);
      } catch (err) {
        logger.warn('git.status_failed', { id, err });
        return sendJson(res, 500, { error: 'git_failed', message: (err as Error).message });
      }
    }
    if (sub === '/files') {
      const p = url.searchParams.get('path') ?? '';
      try {
        const listing = await listDir(meta.dir, p);
        return sendJson(res, 200, listing);
      } catch (err) {
        if (err instanceof PathTraversal) {
          return sendJson(res, 400, { error: 'invalid_path', message: err.message });
        }
        logger.warn('files.list_failed', { id, path: p, err });
        return sendJson(res, 500, { error: 'list_failed', message: (err as Error).message });
      }
    }
  }

  sendJson(res, 404, { error: 'not_found' });
}

function publicMeta(w: WorkspaceMeta): WorkspaceMeta & { readonly claudeRunning: boolean } {
  return { ...w, claudeRunning: pool.isClaudeRunning(w.id) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
    total += buf.length;
    if (total > 64 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (total === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  if (shuttingDown) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/pty') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!isOriginAllowed(req, config)) {
    logger.warn('upgrade.origin_rejected', {
      origin: req.headers.origin ?? null,
      remoteAddress: req.socket.remoteAddress ?? null,
    });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, url);
  });
});

wss.on('connection', (ws: WebSocket, req: IncomingMessage, url: URL) => {
  const wsId = (url.searchParams.get('ws') ?? '').slice(0, 64);
  const cols = clampQuery(url.searchParams.get('cols'), 80, 1, 1000);
  const rows = clampQuery(url.searchParams.get('rows'), 24, 1, 1000);
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw === null ? undefined : parseSince(sinceRaw);

  if (!wsId) {
    logger.warn('upgrade.missing_ws_id');
    try { ws.close(4000, 'ws id required'); } catch { /* ignore */ }
    return;
  }
  if (!registry.get(wsId)) {
    logger.warn('upgrade.unknown_workspace', { wsId });
    try { ws.close(4404, 'workspace not found'); } catch { /* ignore */ }
    return;
  }

  logger.info('upgrade.accepted', {
    wsId,
    cols,
    rows,
    since: since ?? null,
    origin: req.headers.origin ?? null,
    remoteAddress: req.socket.remoteAddress ?? null,
  });

  try {
    pool.attach(wsId, ws, cols, rows, since);
  } catch (err) {
    logger.error('pool.attach_failed', { wsId, err });
    try { ws.close(1011, 'attach failed'); } catch { /* ignore */ }
  }
});

http.listen(config.port, config.host, () => {
  logger.info('server.listening', {
    host: config.host,
    port: config.port,
    command: config.command,
    launcherRoot: config.launcherRoot,
    templatesDir: config.templatesDir,
    templates: templates.list().map((t) => t.name),
    templateDir: config.templateDir,
    sharedDataDir: config.sharedDataDir,
    launcherRepoRoot: config.launcherRepoRoot,
    workspaces: registry.list().length,
    allowedOrigins: config.allowAnyOrigin ? '*' : Array.from(config.allowedOrigins),
  });
});

const shutdown = (reason: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown', { reason, activeSessions: pool.size() });

  pool.disposeAll('server shutdown');
  wss.close();

  const forceTimer = setTimeout(() => {
    logger.warn('server.shutdown_force_exit', { reason });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceTimer.unref();

  http.close(() => {
    logger.info('server.shutdown_complete', { reason });
    clearTimeout(forceTimer);
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { err });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason });
});

function isOriginAllowed(req: IncomingMessage, cfg: ServerConfig): boolean {
  if (cfg.allowAnyOrigin) return true;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  return cfg.allowedOrigins.has(origin);
}

function clampQuery(raw: string | null, fallback: number, lo: number, hi: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function parseSince(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

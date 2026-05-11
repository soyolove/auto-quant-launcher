import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import { loadConfig, type ServerConfig } from './config.js';
import { logger } from './logger.js';
import { SessionPool } from './session-pool.js';
import { buildSpawnEnv } from './spawn-env.js';
import { WorkspaceCreator } from './workspace-creator.js';
import { WorkspaceRegistry, type WorkspaceMeta } from './workspace-registry.js';

const config = loadConfig();

const registry = await WorkspaceRegistry.load(
  `${config.launcherRoot}/workspaces.json`,
  logger.child({ scope: 'registry' }),
);

const creator = new WorkspaceCreator({
  workspacesRoot: `${config.launcherRoot}/workspaces`,
  bootstrapScript: config.bootstrapScript,
  bootstrapEnv: {
    templateDir: config.templateDir,
    sharedDataDir: config.sharedDataDir,
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
      env: buildSpawnEnv(process.env),
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

  if (path === '/api/workspaces') {
    if (method === 'GET') {
      return sendJson(res, 200, {
        workspaces: registry.list().map((w) => publicMeta(w)),
      });
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const tag = typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['tag']
        : undefined;
      if (typeof tag !== 'string') {
        return sendJson(res, 400, { error: 'tag_required' });
      }
      const result = await creator.create(tag);
      if (!result.ok) {
        const status =
          result.code === 'invalid_tag' ? 400
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

  const idMatch = path.match(/^\/api\/workspaces\/([a-zA-Z0-9_-]+)$/);
  if (idMatch && idMatch[1]) {
    const id = idMatch[1];
    if (method === 'DELETE') {
      pool.dispose(id, 'workspace deleted');
      const removed = await registry.remove(id);
      if (!removed) return sendJson(res, 404, { error: 'not_found' });
      logger.info('workspace.removed', { id, dir: removed.dir });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
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
    bootstrapScript: config.bootstrapScript,
    templateDir: config.templateDir,
    sharedDataDir: config.sharedDataDir,
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

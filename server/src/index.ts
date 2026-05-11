import { createServer, type IncomingMessage } from 'node:http';
import { URL } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import { loadConfig, type ServerConfig } from './config.js';
import { logger } from './logger.js';
import { SessionPool } from './session-pool.js';
import { buildSpawnEnv } from './spawn-env.js';

const config = loadConfig();

const http = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
let shuttingDown = false;

const pool = new SessionPool(
  (_wsId) => ({
    command: config.command,
    cwd: config.cwd,
    env: buildSpawnEnv(process.env),
    initialCols: 80,
    initialRows: 24,
    logger: logger.child({ scope: 'session' }),
    replayBufferBytes: config.replayBufferBytes,
    highWatermarkBytes: config.bpHighWatermarkBytes,
    lowWatermarkBytes: config.bpLowWatermarkBytes,
  }),
  logger.child({ scope: 'pool' }),
);

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
  const wsId = (url.searchParams.get('ws') ?? 'default').slice(0, 64) || 'default';
  const cols = clampQuery(url.searchParams.get('cols'), 80, 1, 1000);
  const rows = clampQuery(url.searchParams.get('rows'), 24, 1, 1000);
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw === null ? undefined : parseSince(sinceRaw);

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
    try {
      ws.close(1011, 'attach failed');
    } catch {
      // ignore
    }
  }
});

http.listen(config.port, config.host, () => {
  logger.info('server.listening', {
    host: config.host,
    port: config.port,
    command: config.command,
    cwd: config.cwd,
    replayBufferBytes: config.replayBufferBytes,
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

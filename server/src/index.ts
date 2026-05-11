import { createServer, type IncomingMessage } from 'node:http';
import { URL } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import { loadConfig, type ServerConfig } from './config.js';
import { logger } from './logger.js';
import { PtySession } from './session.js';
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
const sessions = new Set<PtySession>();
let shuttingDown = false;
let nextSessionId = 1;

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
  const cols = clampQuery(url.searchParams.get('cols'), 80, 1, 1000);
  const rows = clampQuery(url.searchParams.get('rows'), 24, 1, 1000);
  const sessionId = nextSessionId++;
  const sessionLog = logger.child({
    sessionId,
    origin: req.headers.origin ?? null,
    remoteAddress: req.socket.remoteAddress ?? null,
  });

  try {
    const session: PtySession = new PtySession(ws, {
      command: config.command,
      cwd: config.cwd,
      env: buildSpawnEnv(process.env),
      cols,
      rows,
      highWatermarkBytes: config.bpHighWatermarkBytes,
      lowWatermarkBytes: config.bpLowWatermarkBytes,
      logger: sessionLog,
      onClose: () => {
        sessions.delete(session);
        sessionLog.info('session.closed', { activeSessions: sessions.size });
      },
    });
    sessions.add(session);
    sessionLog.info('session.opened', { activeSessions: sessions.size });
  } catch (err) {
    sessionLog.error('session.spawn_failed', { err });
    try {
      ws.close(1011, 'spawn failed');
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
    allowedOrigins: config.allowAnyOrigin ? '*' : Array.from(config.allowedOrigins),
  });
});

const shutdown = (reason: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown', { reason, activeSessions: sessions.size });

  for (const s of sessions) s.dispose('server shutdown');
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
  // Same-origin requests (e.g. curl, Node ws client) often omit Origin entirely.
  // Treat absent Origin as same-origin and allow it — browsers always send one.
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

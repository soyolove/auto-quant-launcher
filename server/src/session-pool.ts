import type { WebSocket } from 'ws';

import type { Logger } from './logger.js';
import {
  PersistentSession,
  type PersistentSessionOptions,
} from './persistent-session.js';

/**
 * Per-attach context the factory uses to decide how to spawn a fresh
 * PersistentSession. `resume` is only meaningful at session-creation time;
 * if a session already exists for this wsId, the factory is never called
 * and any resume intent on the attach is silently ignored (the live PTY
 * is already in some state — we don't restart it).
 */
export interface SessionFactoryContext {
  readonly resume?: 'last' | { sessionId: string };
}

/**
 * Factory hands back everything `PersistentSession` needs *except* the
 * wsId-bound bookkeeping (wsId + onDisposed) — the pool fills those in.
 */
export type SessionConfigFactory = (
  wsId: string,
  ctx: SessionFactoryContext,
) => Omit<PersistentSessionOptions, 'wsId' | 'onDisposed'>;

/**
 * One pool entry per wsId. PTYs live here, decoupled from any WebSocket.
 *
 * v1 invariants:
 * - at most one `PersistentSession` per wsId
 * - at most one attached WebSocket per session; second attach kicks the first
 * - sessions only exist after the first attach for their wsId
 * - when a session disposes itself (child exit), it removes itself from the map
 */
export class SessionPool {
  private readonly sessions = new Map<string, PersistentSession>();

  constructor(
    private readonly configFactory: SessionConfigFactory,
    private readonly logger: Logger,
  ) {}

  attach(
    wsId: string,
    ws: WebSocket,
    cols: number,
    rows: number,
    since: number | undefined,
    factoryCtx: SessionFactoryContext = {},
  ): void {
    let session = this.sessions.get(wsId);
    if (!session) {
      const opts = this.configFactory(wsId, factoryCtx);
      session = new PersistentSession({
        ...opts,
        wsId,
        onDisposed: () => {
          this.sessions.delete(wsId);
          this.logger.info('pool.session_removed', {
            wsId,
            remaining: this.sessions.size,
          });
        },
      });
      this.sessions.set(wsId, session);
      this.logger.info('pool.session_created', {
        wsId,
        total: this.sessions.size,
      });
    }
    session.attach(ws, cols, rows, since);
  }

  has(wsId: string): boolean {
    return this.sessions.has(wsId);
  }

  isClaudeRunning(wsId: string): boolean {
    return this.sessions.has(wsId);
  }

  size(): number {
    return this.sessions.size;
  }

  dispose(wsId: string, reason: string): boolean {
    const session = this.sessions.get(wsId);
    if (!session) return false;
    session.dispose(reason);
    // session.dispose triggers onDisposed which removes from the map.
    return true;
  }

  disposeAll(reason: string): void {
    for (const session of this.sessions.values()) {
      session.dispose(reason);
    }
    this.sessions.clear();
  }
}

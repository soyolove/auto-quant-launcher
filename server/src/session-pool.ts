import type { WebSocket } from 'ws';

import type { Logger } from './logger.js';
import {
  PersistentSession,
  type PersistentSessionOptions,
} from './persistent-session.js';

/**
 * Factory hands back everything `PersistentSession` needs *except* the
 * wsId-bound bookkeeping (wsId + onDisposed) — the pool fills those in.
 */
export type SessionConfigFactory = (
  wsId: string,
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

  attach(wsId: string, ws: WebSocket, cols: number, rows: number, since: number | undefined): void {
    let session = this.sessions.get(wsId);
    if (!session) {
      const opts = this.configFactory(wsId);
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

  size(): number {
    return this.sessions.size;
  }

  disposeAll(reason: string): void {
    for (const session of this.sessions.values()) {
      session.dispose(reason);
    }
    this.sessions.clear();
  }
}

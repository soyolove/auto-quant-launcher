import { randomUUID } from 'node:crypto';

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
 * wsId-bound bookkeeping (wsId + sessionToken + name + onDisposed) — the
 * pool fills those in.
 */
export type SessionConfigFactory = (
  wsId: string,
  ctx: SessionFactoryContext,
) => Omit<PersistentSessionOptions, 'wsId' | 'sessionToken' | 'name' | 'onDisposed'>;

/**
 * The pool owns all live PTYs. As of M1 the public attach() behavior is
 * unchanged ("at most one PTY per workspace, second attach reuses it"),
 * but internally we've switched to token-as-primary-key + byWs reverse
 * index. M2 will lift the 1:1 invariant and add token-explicit spawn /
 * stop APIs on top of these maps.
 *
 * Invariants (still v1):
 * - one PersistentSession per sessionToken
 * - one attached WebSocket per session; second attach kicks the first
 * - sessions exist only after first attach (transient — server restart clears)
 * - PersistentSession.onDisposed cleans up both maps
 */
export class SessionPool {
  private readonly sessions = new Map<string, PersistentSession>();
  private readonly byWs = new Map<string, Set<string>>();
  private readonly nameCounters = new Map<string, number>();

  constructor(
    private readonly configFactory: SessionConfigFactory,
    private readonly logger: Logger,
  ) {}

  /**
   * Attach a WS to a workspace's session. Spawns a fresh PTY if the
   * workspace has none yet; otherwise attaches to the (sole, in M1)
   * existing one and the resume intent is ignored.
   */
  attach(
    wsId: string,
    ws: WebSocket,
    cols: number,
    rows: number,
    since: number | undefined,
    factoryCtx: SessionFactoryContext = {},
  ): void {
    const existing = this.firstTokenFor(wsId);
    const session = existing
      ? this.sessions.get(existing)!
      : this.spawnInternal(wsId, factoryCtx);
    session.attach(ws, cols, rows, since);
  }

  has(wsId: string): boolean {
    return this.byWs.has(wsId) && this.byWs.get(wsId)!.size > 0;
  }

  /**
   * True if the workspace has at least one live PTY. Old single-session
   * name kept so callers (publicMeta in index.ts) don't churn in M1.
   * Will be renamed/augmented with `liveSessionCount` in M2.
   */
  isClaudeRunning(wsId: string): boolean {
    return this.has(wsId);
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Dispose ALL sessions for a workspace. Matches the existing
   * "stop the workspace" semantics; in M2 we'll add `disposeToken`
   * for per-tab ■ stops.
   */
  dispose(wsId: string, reason: string): boolean {
    const tokens = this.byWs.get(wsId);
    if (!tokens || tokens.size === 0) return false;
    // Copy first — session.dispose() triggers onDisposed which mutates byWs.
    const snapshot = Array.from(tokens);
    for (const token of snapshot) {
      const s = this.sessions.get(token);
      if (s) s.dispose(reason);
    }
    return true;
  }

  disposeAll(reason: string): void {
    for (const session of Array.from(this.sessions.values())) {
      session.dispose(reason);
    }
    this.sessions.clear();
    this.byWs.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private firstTokenFor(wsId: string): string | undefined {
    const tokens = this.byWs.get(wsId);
    if (!tokens || tokens.size === 0) return undefined;
    // Iteration order on a Set is insertion order; first = most recently
    // spawned only if we never re-add. In M1 there's only one per wsId so
    // this is unambiguous; M2 will introduce "pick most recent" semantics
    // when the set has multiple entries.
    return tokens.values().next().value;
  }

  private spawnInternal(wsId: string, factoryCtx: SessionFactoryContext): PersistentSession {
    const sessionToken = randomUUID();
    const counter = (this.nameCounters.get(wsId) ?? 0) + 1;
    this.nameCounters.set(wsId, counter);
    const name = `s${counter}`;

    const opts = this.configFactory(wsId, factoryCtx);
    const session = new PersistentSession({
      ...opts,
      wsId,
      sessionToken,
      name,
      onDisposed: () => this.onSessionDisposed(wsId, sessionToken),
    });

    this.sessions.set(sessionToken, session);
    let tokens = this.byWs.get(wsId);
    if (!tokens) {
      tokens = new Set();
      this.byWs.set(wsId, tokens);
    }
    tokens.add(sessionToken);
    this.logger.info('pool.session_created', {
      wsId,
      sessionToken,
      name,
      total: this.sessions.size,
      forWorkspace: tokens.size,
    });
    return session;
  }

  private onSessionDisposed(wsId: string, sessionToken: string): void {
    this.sessions.delete(sessionToken);
    const tokens = this.byWs.get(wsId);
    if (tokens) {
      tokens.delete(sessionToken);
      if (tokens.size === 0) this.byWs.delete(wsId);
    }
    this.logger.info('pool.session_removed', {
      wsId,
      sessionToken,
      remaining: this.sessions.size,
      forWorkspace: tokens?.size ?? 0,
    });
  }
}

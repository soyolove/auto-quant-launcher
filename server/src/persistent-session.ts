import * as pty from 'node-pty';
import type { WebSocket } from 'ws';

import type { Logger } from './logger.js';
import {
  isClientControlMessage,
  type ServerControlMessage,
} from './protocol.js';
import { ReplayBuffer } from './replay-buffer.js';

export interface PersistentSessionOptions {
  readonly wsId: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: { [key: string]: string };
  readonly initialCols: number;
  readonly initialRows: number;
  readonly logger: Logger;
  readonly replayBufferBytes: number;
  readonly highWatermarkBytes: number;
  readonly lowWatermarkBytes: number;
  readonly onDisposed: () => void;
}

const MAX_DIM = 1000;
const CURSOR_TICK_MS = 2000;
const CURSOR_BYTES_INTERVAL = 64 * 1024;

/**
 * A PTY whose lifetime is decoupled from any single WebSocket.
 *
 * The session owns the child process, a `ReplayBuffer` of recent output, and
 * (at most one at a time, for v1) an attached WebSocket. On `attach`, any
 * prior client is kicked, the replay tail is shipped as a binary frame, then
 * an `attached` text frame tells the client where the seq starts.
 *
 * Output flow:
 *   pty.onData → buffer.append(buf) → if ws is attached, ws.send(buf, binary)
 * Cursor heartbeats (text `cursor` messages) are emitted every
 * CURSOR_BYTES_INTERVAL bytes of output or CURSOR_TICK_MS of idle time, so
 * the client can persist `lastSeq` and request a tight replay window on
 * reattach.
 */
export class PersistentSession {
  private readonly term: pty.IPty;
  private readonly buffer: ReplayBuffer;
  private readonly opts: PersistentSessionOptions;
  private readonly log: Logger;
  private ws: WebSocket | null = null;
  private paused = false;
  private disposed = false;
  private cursorTimer: NodeJS.Timeout | null = null;
  private lastCursorSeq = 0;
  private messageHandler: ((raw: unknown, isBinary: boolean) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: (() => void) | null = null;

  constructor(opts: PersistentSessionOptions) {
    this.opts = opts;
    this.log = opts.logger.child({ wsId: opts.wsId });
    this.buffer = new ReplayBuffer(opts.replayBufferBytes);

    const [argv0, ...args] = opts.command;
    if (!argv0) throw new Error('command must contain at least one argv element');

    this.term = pty.spawn(argv0, args, {
      name: 'xterm-256color',
      cols: clamp(opts.initialCols, 1, MAX_DIM),
      rows: clamp(opts.initialRows, 1, MAX_DIM),
      cwd: opts.cwd,
      env: opts.env,
      // Raw bytes; xterm.js decodes UTF-8 with proper streaming state.
      encoding: null,
    });

    this.log.info('session.spawned', {
      pid: this.term.pid,
      command: opts.command,
      cwd: opts.cwd,
    });

    this.term.onData((data) => this.onPtyData(data as unknown as Buffer | string));
    this.term.onExit(({ exitCode, signal }) => {
      this.log.info('session.child_exit', {
        pid: this.term.pid,
        code: exitCode,
        signal: signal ?? null,
      });
      this.sendControl({
        type: 'exit',
        code: exitCode,
        signal: typeof signal === 'number' ? signal : null,
      });
      this.dispose('child exited');
    });
  }

  get pid(): number {
    return this.term.pid;
  }

  get command(): readonly string[] {
    return this.opts.command;
  }

  /** Swap in `ws` as the attached client; kick the previous one if any. */
  attach(ws: WebSocket, cols: number, rows: number, since: number | undefined): void {
    if (this.disposed) {
      try {
        ws.close(1011, 'session disposed');
      } catch {
        // ignore
      }
      return;
    }

    // Kick previous client.
    if (this.ws !== null && this.ws !== ws) {
      const prev = this.ws;
      this.unwireWs(prev);
      this.ws = null;
      try {
        prev.close(4001, 'kicked by new attach');
      } catch {
        // ignore
      }
    }

    this.ws = ws;
    this.paused = false;
    this.resize(cols, rows);

    // Compute replay window. Cold attach (since=undefined) means "send no
    // backlog" — the client wants a fresh-looking screen, just starting
    // from now.
    const requested = since ?? this.buffer.tailSeq;
    const slice = this.buffer.since(requested);
    const scrollbackTruncated = since !== undefined && slice.effectiveSeq > since;

    if (slice.bytes.length > 0) {
      ws.send(slice.bytes, { binary: true });
    }
    const attached: ServerControlMessage = {
      type: 'attached',
      wsId: this.opts.wsId,
      pid: this.term.pid,
      command: this.opts.command,
      replayFromSeq: slice.effectiveSeq,
      seq: slice.tailSeq,
      scrollbackTruncated,
    };
    ws.send(JSON.stringify(attached));
    this.lastCursorSeq = slice.tailSeq;

    this.wireWs(ws);
    this.startCursorTimer();

    this.log.info('session.attached', {
      since: since ?? null,
      replayFromSeq: slice.effectiveSeq,
      replayBytes: slice.bytes.length,
      scrollbackTruncated,
    });
  }

  /** Drop the current client without killing the PTY. */
  detach(): void {
    if (this.ws === null) return;
    const ws = this.ws;
    this.ws = null;
    this.unwireWs(ws);
    if (this.cursorTimer) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = null;
    }
    this.log.info('session.detached');
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.cursorTimer) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = null;
    }
    try {
      this.term.kill();
    } catch {
      // already dead
    }
    const ws = this.ws;
    if (ws !== null) {
      this.unwireWs(ws);
      this.ws = null;
      try {
        ws.close(1000, `disposed: ${reason}`);
      } catch {
        // ignore
      }
    }
    this.log.info('session.disposed', { reason });
    this.opts.onDisposed();
  }

  private onPtyData(data: Buffer | string): void {
    if (this.disposed) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.buffer.append(buf);

    const ws = this.ws;
    if (ws !== null) {
      ws.send(buf, { binary: true }, (err) => {
        if (err) {
          this.log.warn('session.send_error', { err });
          return;
        }
        if (this.paused && ws.bufferedAmount <= this.opts.lowWatermarkBytes) {
          this.paused = false;
          try {
            this.term.resume();
          } catch {
            // ignore
          }
        }
      });

      if (!this.paused && ws.bufferedAmount >= this.opts.highWatermarkBytes) {
        this.paused = true;
        try {
          this.term.pause();
        } catch {
          // ignore
        }
      }
    }

    if (this.buffer.tailSeq - this.lastCursorSeq >= CURSOR_BYTES_INTERVAL) {
      this.maybeSendCursor();
    }
  }

  private onWsMessage(ws: WebSocket, raw: unknown, isBinary: boolean): void {
    if (this.disposed) return;
    if (this.ws !== ws) return; // stale (this ws was kicked)

    if (isBinary) {
      const buf = toBuffer(raw);
      if (!buf) return;
      try {
        this.term.write(buf.toString('utf8'));
      } catch (err) {
        this.log.warn('session.write_error', { err });
      }
      return;
    }

    const buf = toBuffer(raw);
    if (!buf) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!isClientControlMessage(parsed)) return;

    if (parsed.type === 'resize') {
      this.resize(parsed.cols, parsed.rows);
    }
    // `attach` mid-stream is ignored — the initial attach already happened.
  }

  private wireWs(ws: WebSocket): void {
    const messageHandler = (raw: unknown, isBinary: boolean): void =>
      this.onWsMessage(ws, raw, isBinary);
    const closeHandler = (): void => {
      if (this.ws === ws) this.detach();
    };
    const errorHandler = closeHandler;
    ws.on('message', messageHandler);
    ws.on('close', closeHandler);
    ws.on('error', errorHandler);
    this.messageHandler = messageHandler;
    this.closeHandler = closeHandler;
    this.errorHandler = errorHandler;
  }

  private unwireWs(ws: WebSocket): void {
    if (this.messageHandler) ws.off('message', this.messageHandler);
    if (this.closeHandler) ws.off('close', this.closeHandler);
    if (this.errorHandler) ws.off('error', this.errorHandler);
    this.messageHandler = null;
    this.closeHandler = null;
    this.errorHandler = null;
  }

  private resize(cols: number, rows: number): void {
    const c = clamp(Math.floor(cols), 1, MAX_DIM);
    const r = clamp(Math.floor(rows), 1, MAX_DIM);
    try {
      this.term.resize(c, r);
    } catch {
      // PTY may be dying; ignore.
    }
  }

  private sendControl(msg: ServerControlMessage): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore — ws may have just closed
    }
  }

  private startCursorTimer(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    const t = setInterval(() => this.maybeSendCursor(), CURSOR_TICK_MS);
    t.unref();
    this.cursorTimer = t;
  }

  private maybeSendCursor(): void {
    if (this.disposed || this.ws === null) return;
    const seq = this.buffer.tailSeq;
    if (seq === this.lastCursorSeq) return;
    this.lastCursorSeq = seq;
    this.sendControl({ type: 'cursor', seq });
  }
}

function toBuffer(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((r) => toBuffer(r) ?? Buffer.alloc(0)));
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

import * as pty from 'node-pty';
import type { WebSocket } from 'ws';

import {
  isClientControlMessage,
  type ServerControlMessage,
} from './protocol.js';
import type { Logger } from './logger.js';

export interface SessionOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cols: number;
  readonly rows: number;
  readonly logger: Logger;
  /** Pause node-pty when ws.bufferedAmount exceeds this many bytes. */
  readonly highWatermarkBytes: number;
  /** Resume node-pty when ws.bufferedAmount drops below this many bytes. */
  readonly lowWatermarkBytes: number;
  /** Called once when the session is fully torn down (either side). */
  readonly onClose: () => void;
}

const MAX_DIM = 1000;

/**
 * Bridges one WebSocket connection to one PTY process.
 *
 * Data path: raw bytes both ways. node-pty runs with encoding=null so OS-level
 * read chunks don't get UTF-8-decoded across multibyte boundaries (xterm.js on
 * the client has a proper streaming decoder).
 *
 * Backpressure: outbound writes go through the ws send callback. When
 * ws.bufferedAmount climbs above the high-watermark we call term.pause() so
 * the kernel pipe applies pressure to the child. When the callback fires and
 * bufferedAmount has drained below the low-watermark we resume.
 */
export class PtySession {
  private readonly term: pty.IPty;
  private readonly ws: WebSocket;
  private readonly log: Logger;
  private readonly highWm: number;
  private readonly lowWm: number;
  private readonly onCloseCb: () => void;
  private disposed = false;
  private paused = false;

  constructor(ws: WebSocket, opts: SessionOptions) {
    this.ws = ws;
    this.log = opts.logger;
    this.highWm = opts.highWatermarkBytes;
    this.lowWm = opts.lowWatermarkBytes;
    this.onCloseCb = opts.onClose;

    const [argv0, ...args] = opts.command;
    if (!argv0) throw new Error('command must contain at least one argv element');

    this.term = pty.spawn(argv0, args, {
      name: 'xterm-256color',
      cols: clamp(opts.cols, 1, MAX_DIM),
      rows: clamp(opts.rows, 1, MAX_DIM),
      cwd: opts.cwd,
      env: filterEnv(opts.env),
      // Raw bytes — let xterm.js decode UTF-8 with proper streaming state.
      encoding: null,
    });

    this.log.info('session.spawn', {
      pid: this.term.pid,
      command: opts.command,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
    });

    this.send({
      type: 'ready',
      pid: this.term.pid,
      command: Array.from(opts.command),
      cols: opts.cols,
      rows: opts.rows,
    });

    // Cast away the typings lie: with encoding=null, runtime delivers Buffer.
    this.term.onData((data) => this.onPtyData(data as unknown as Buffer | string));

    this.term.onExit(({ exitCode, signal }) => {
      this.log.info('session.exit', { pid: this.term.pid, code: exitCode, signal: signal ?? null });
      this.send({
        type: 'exit',
        code: exitCode,
        signal: typeof signal === 'number' ? signal : null,
      });
      this.dispose('pty exited');
    });

    ws.on('message', (raw, isBinary) => this.onWsMessage(raw, isBinary));
    ws.on('close', (code, reason) => {
      this.log.info('session.ws_close', { pid: this.term.pid, code, reason: reason.toString() });
      this.dispose('ws closed');
    });
    ws.on('error', (err) => {
      this.log.warn('session.ws_error', { pid: this.term.pid, err });
      this.dispose('ws error');
    });
  }

  private onPtyData(data: Buffer | string): void {
    if (this.disposed) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');

    this.ws.send(buf, { binary: true }, (err) => {
      if (err) {
        this.log.warn('session.send_error', { pid: this.term.pid, err });
        return;
      }
      if (this.paused && this.ws.bufferedAmount <= this.lowWm) {
        this.paused = false;
        try {
          this.term.resume();
        } catch {
          // PTY may have exited; ignore.
        }
      }
    });

    if (!this.paused && this.ws.bufferedAmount >= this.highWm) {
      this.paused = true;
      this.log.debug('session.backpressure_pause', {
        pid: this.term.pid,
        buffered: this.ws.bufferedAmount,
      });
      try {
        this.term.pause();
      } catch {
        // PTY may have exited; ignore.
      }
    }
  }

  private onWsMessage(raw: unknown, isBinary: boolean): void {
    if (this.disposed) return;

    if (isBinary) {
      const buf = toBuffer(raw);
      if (!buf) return;
      // Keyboard / paste input. xterm.js sends already-complete UTF-8 sequences,
      // so decoding-then-writing is safe (and node-pty.write only accepts string).
      try {
        this.term.write(buf.toString('utf8'));
      } catch (err) {
        this.log.warn('session.write_error', { pid: this.term.pid, err });
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
      const cols = clamp(Math.floor(parsed.cols), 1, MAX_DIM);
      const rows = clamp(Math.floor(parsed.rows), 1, MAX_DIM);
      try {
        this.term.resize(cols, rows);
      } catch {
        // PTY may be gone mid-flight; ignore.
      }
    }
  }

  private send(msg: ServerControlMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.term.kill();
    } catch {
      // already dead
    }
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      try {
        this.ws.close(1000, reason);
      } catch {
        // ignore
      }
    }
    this.onCloseCb();
  }
}

function toBuffer(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw.map((r) => toBuffer(r) ?? Buffer.alloc(0)));
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function filterEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

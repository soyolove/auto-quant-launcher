import { homedir } from 'node:os';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowAnyOrigin: boolean;
  /** Outbound buffer high-watermark before we pause the PTY. */
  readonly bpHighWatermarkBytes: number;
  /** Outbound buffer low-watermark before we resume the PTY. */
  readonly bpLowWatermarkBytes: number;
  /** Time we wait for clean shutdown before forcing the process to exit. */
  readonly shutdownTimeoutMs: number;
  /** Per-session replay ring-buffer cap, in bytes. */
  readonly replayBufferBytes: number;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_HIGH_WM = 1 * 1024 * 1024; // 1 MiB
const DEFAULT_LOW_WM = 256 * 1024; // 256 KiB
const DEFAULT_SHUTDOWN_MS = 5_000;
const DEFAULT_REPLAY_BYTES = 512 * 1024; // 512 KiB

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parseInt(env['PORT'], DEFAULT_PORT, 1, 65535);
  const host = env['HOST'] ?? DEFAULT_HOST;

  const command = parseCommand(env['WEB_TERMINAL_COMMAND'], env['SHELL']);
  const cwd = env['WEB_TERMINAL_CWD'] ?? homedir();

  const originsRaw = (env['WEB_TERMINAL_ALLOWED_ORIGINS'] ?? DEFAULT_ORIGINS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAnyOrigin = originsRaw.includes('*');
  const allowedOrigins = new Set(originsRaw.filter((s) => s !== '*'));

  const bpHigh = parseInt(env['WEB_TERMINAL_BP_HIGH'], DEFAULT_HIGH_WM, 1024, 1024 * 1024 * 1024);
  const bpLow = parseInt(env['WEB_TERMINAL_BP_LOW'], DEFAULT_LOW_WM, 0, bpHigh);
  const shutdownTimeoutMs = parseInt(
    env['WEB_TERMINAL_SHUTDOWN_MS'],
    DEFAULT_SHUTDOWN_MS,
    100,
    60_000,
  );
  const replayBufferBytes = parseInt(
    env['WEB_TERMINAL_REPLAY_BYTES'],
    DEFAULT_REPLAY_BYTES,
    1024,
    64 * 1024 * 1024,
  );

  return {
    host,
    port,
    command,
    cwd,
    allowedOrigins,
    allowAnyOrigin,
    bpHighWatermarkBytes: bpHigh,
    bpLowWatermarkBytes: bpLow,
    shutdownTimeoutMs,
    replayBufferBytes,
  };
}

/**
 * Parse the command spec from env. Priority:
 *   1. WEB_TERMINAL_COMMAND as JSON array (e.g. `["claude","--dangerously-skip-permissions"]`)
 *   2. WEB_TERMINAL_COMMAND as whitespace-split argv (e.g. `claude --foo`)
 *   3. $SHELL, falling back to /bin/zsh (macOS/Linux) or powershell.exe (Windows)
 */
function parseCommand(raw: string | undefined, shell: string | undefined): readonly string[] {
  if (raw && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string') && parsed.length > 0) {
          return parsed;
        }
      } catch {
        // fall through to whitespace split
      }
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length > 0 && parts[0]) return parts;
  }
  const defaultShell =
    shell ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
  return [defaultShell];
}

function parseInt(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

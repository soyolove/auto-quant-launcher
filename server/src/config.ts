import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly command: readonly string[];
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
  /** Launcher state root — registry, workspaces dir, shared data live here. */
  readonly launcherRoot: string;
  /** Path to the bootstrap script invoked when creating a workspace. */
  readonly bootstrapScript: string;
  /** Path to an Auto-Quant clone the bootstrap script reads from. */
  readonly templateDir: string;
  /** Directory holding shared *.feather files (bootstrap symlinks into it). */
  readonly sharedDataDir: string;
  /** Bootstrap script kill timeout. */
  readonly bootstrapTimeoutMs: number;
}

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_HIGH_WM = 1 * 1024 * 1024;
const DEFAULT_LOW_WM = 256 * 1024;
const DEFAULT_SHUTDOWN_MS = 5_000;
const DEFAULT_REPLAY_BYTES = 512 * 1024;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 60_000;

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parseIntEnv(env['PORT'], DEFAULT_PORT, 1, 65535);
  const host = env['HOST'] ?? DEFAULT_HOST;

  const command = parseCommand(env['WEB_TERMINAL_COMMAND']);

  const originsRaw = (env['WEB_TERMINAL_ALLOWED_ORIGINS'] ?? DEFAULT_ORIGINS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAnyOrigin = originsRaw.includes('*');
  const allowedOrigins = new Set(originsRaw.filter((s) => s !== '*'));

  const bpHigh = parseIntEnv(env['WEB_TERMINAL_BP_HIGH'], DEFAULT_HIGH_WM, 1024, 1024 * 1024 * 1024);
  const bpLow = parseIntEnv(env['WEB_TERMINAL_BP_LOW'], DEFAULT_LOW_WM, 0, bpHigh);
  const shutdownTimeoutMs = parseIntEnv(
    env['WEB_TERMINAL_SHUTDOWN_MS'],
    DEFAULT_SHUTDOWN_MS,
    100,
    60_000,
  );
  const replayBufferBytes = parseIntEnv(
    env['WEB_TERMINAL_REPLAY_BYTES'],
    DEFAULT_REPLAY_BYTES,
    1024,
    64 * 1024 * 1024,
  );

  const launcherRoot = resolve(
    env['AQ_LAUNCHER_ROOT'] ?? join(homedir(), '.auto-quant-launcher'),
  );
  const bootstrapScript = resolve(
    env['AQ_BOOTSTRAP_SCRIPT'] ?? defaultBootstrapScript(),
  );
  const templateDir = resolve(
    env['AQ_TEMPLATE_DIR'] ?? '/Users/ame/2605dev/Auto-Quant',
  );
  const sharedDataDir = resolve(
    env['AQ_SHARED_DATA_DIR'] ?? join(launcherRoot, 'data'),
  );
  const bootstrapTimeoutMs = parseIntEnv(
    env['AQ_BOOTSTRAP_TIMEOUT_MS'],
    DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    1_000,
    600_000,
  );

  return {
    host,
    port,
    command,
    allowedOrigins,
    allowAnyOrigin,
    bpHighWatermarkBytes: bpHigh,
    bpLowWatermarkBytes: bpLow,
    shutdownTimeoutMs,
    replayBufferBytes,
    launcherRoot,
    bootstrapScript,
    templateDir,
    sharedDataDir,
    bootstrapTimeoutMs,
  };
}

function parseCommand(raw: string | undefined): readonly string[] {
  if (raw && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          Array.isArray(parsed) &&
          parsed.every((v): v is string => typeof v === 'string') &&
          parsed.length > 0
        ) {
          return parsed;
        }
      } catch {
        // fall through to whitespace split
      }
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length > 0 && parts[0]) return parts;
  }
  return ['claude'];
}

function parseIntEnv(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function defaultBootstrapScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/config.ts → ../scripts/bootstrap-auto-quant.sh
  return join(here, '..', 'scripts', 'bootstrap-auto-quant.sh');
}

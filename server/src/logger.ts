/**
 * Tiny structured logger. One JSON line per log record on stdout, errors on stderr.
 * Keep it hand-rolled so we don't pull in a dep just for boot-time noise.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (process.env['WEB_TERMINAL_LOG_LEVEL'] ?? 'info').toLowerCase();
const minLevel: number = LEVELS[envLevel as Level] ?? LEVELS.info;

function emit(level: Level, msg: string, fields: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(record, replacer);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function make(bindings: Record<string, unknown>): Logger {
  const merge = (fields?: Record<string, unknown>): Record<string, unknown> =>
    fields === undefined ? bindings : { ...bindings, ...fields };
  return {
    debug: (msg, fields) => emit('debug', msg, merge(fields)),
    info: (msg, fields) => emit('info', msg, merge(fields)),
    warn: (msg, fields) => emit('warn', msg, merge(fields)),
    error: (msg, fields) => emit('error', msg, merge(fields)),
    child: (extra) => make({ ...bindings, ...extra }),
  };
}

export const logger: Logger = make({});

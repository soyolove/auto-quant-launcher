/**
 * Wire protocol shared between the WebSocket server and browser client.
 *
 * Binary frames carry raw PTY bytes in both directions.
 * Text frames carry small JSON control messages described below.
 */

export interface ResizeMessage {
  readonly type: 'resize';
  readonly cols: number;
  readonly rows: number;
}

export type ClientControlMessage = ResizeMessage;

export interface ReadyMessage {
  readonly type: 'ready';
  readonly pid: number;
  readonly command: readonly string[];
  readonly cols: number;
  readonly rows: number;
}

export interface ExitMessage {
  readonly type: 'exit';
  readonly code: number;
  readonly signal: number | null;
}

export type ServerControlMessage = ReadyMessage | ExitMessage;

export function isClientControlMessage(value: unknown): value is ClientControlMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['type'] === 'resize') {
    return (
      typeof v['cols'] === 'number' &&
      typeof v['rows'] === 'number' &&
      Number.isFinite(v['cols']) &&
      Number.isFinite(v['rows']) &&
      (v['cols'] as number) > 0 &&
      (v['rows'] as number) > 0
    );
  }
  return false;
}

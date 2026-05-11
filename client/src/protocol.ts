/**
 * Mirror of server/src/protocol.ts. Kept as a separate file so the two
 * packages stay independently buildable without a shared workspace.
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

export function parseServerControl(text: string): ServerControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v['type']) {
    case 'ready':
      if (
        typeof v['pid'] === 'number' &&
        Array.isArray(v['command']) &&
        v['command'].every((c) => typeof c === 'string') &&
        typeof v['cols'] === 'number' &&
        typeof v['rows'] === 'number'
      ) {
        return {
          type: 'ready',
          pid: v['pid'],
          command: v['command'] as string[],
          cols: v['cols'],
          rows: v['rows'],
        };
      }
      return null;
    case 'exit':
      if (typeof v['code'] === 'number') {
        return {
          type: 'exit',
          code: v['code'],
          signal: typeof v['signal'] === 'number' ? v['signal'] : null,
        };
      }
      return null;
    default:
      return null;
  }
}

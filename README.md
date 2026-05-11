# web-terminal

A browser-based terminal built the same way VSCode builds its integrated terminal:

- **Front-end**: Vite + React + strict TypeScript + [xterm.js](https://xtermjs.org/) (with `fit`, `web-links`, `webgl` addons).
- **Back-end**: Node.js + [`ws`](https://github.com/websockets/ws) + [`node-pty`](https://github.com/microsoft/node-pty) (real PTY: `forkpty(3)` on macOS/Linux, ConPTY on Windows).
- **Transport**: WebSocket. Binary frames carry raw PTY bytes both directions; text frames carry small JSON control messages (`resize`).

## Quick start

```bash
cd web-terminal
pnpm install
pnpm dev
```

Then open `http://localhost:5173`. Vite proxies `/pty` to the WebSocket server on `127.0.0.1:8787`.

## Scripts

- `pnpm dev` — runs server + client in parallel.
- `pnpm build` — type-checks and bundles both packages.
- `pnpm typecheck` — strict typecheck only, no emit.

## Layout

```
server/  # ws + node-pty PTY broker
client/  # Vite + React + xterm.js
```

## Configuration (server)

All optional. Set via env vars:

| Variable                          | Default                                      | Meaning                                                                  |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `PORT`                            | `8787`                                       | WS server listen port.                                                   |
| `HOST`                            | `127.0.0.1`                                  | Bind address. Use `0.0.0.0` for LAN access (also set allowed origins!).  |
| `WEB_TERMINAL_COMMAND`            | `$SHELL` or `/bin/zsh`                       | Command to spawn. JSON array (`["claude","--foo"]`) or whitespace argv.  |
| `WEB_TERMINAL_CWD`                | `$HOME`                                      | Working directory for the spawned command.                               |
| `WEB_TERMINAL_ALLOWED_ORIGINS`    | `http://localhost:5173,http://127.0.0.1:5173`| Comma-separated allowlist for the WS upgrade `Origin` header, or `*`.    |
| `WEB_TERMINAL_BP_HIGH`            | `1048576` (1 MiB)                            | Pause PTY when `ws.bufferedAmount` exceeds this many bytes.              |
| `WEB_TERMINAL_BP_LOW`             | `262144` (256 KiB)                           | Resume PTY when `ws.bufferedAmount` drops below this many bytes.         |
| `WEB_TERMINAL_SHUTDOWN_MS`        | `5000`                                       | Hard-exit timeout on SIGTERM/SIGINT.                                     |
| `WEB_TERMINAL_LOG_LEVEL`          | `info`                                       | One of `debug`, `info`, `warn`, `error`.                                 |

Examples:

```bash
# Launch claude code directly instead of a shell
WEB_TERMINAL_COMMAND='["claude"]' pnpm dev

# Allow access from another host on your LAN
HOST=0.0.0.0 WEB_TERMINAL_ALLOWED_ORIGINS=http://192.168.1.42:5173 pnpm dev
```

## Protocol

`ws://host/pty?cols=N&rows=N`

| Direction       | Frame type | Meaning                                |
| --------------- | ---------- | -------------------------------------- |
| client → server | binary     | stdin bytes (UTF-8) to the PTY         |
| client → server | text/JSON  | control: `{type:"resize",cols,rows}`   |
| server → client | binary     | raw stdout/stderr bytes from the PTY   |
| server → client | text/JSON  | control: `ready` on spawn, `exit` on close |

Server→client PTY bytes are **raw** (not re-decoded). xterm.js does streaming UTF-8 decoding on the client, so multi-byte characters (CJK, emoji) split across OS read boundaries don't produce mojibake.

## Key remapping

`TerminalView` accepts a `keyMap` prop that intercepts keystrokes **before** xterm.js sees them, then sends the mapped bytes straight to the PTY. Architecturally this is the same layer as VSCode's `keybindings.json` for the integrated terminal — it sits above xterm.js, not inside it.

```tsx
<TerminalView keyMap={{
  'shift+enter': '\x1b\r',   // Claude Code multiline (iTerm2-style)
  'alt+enter':   '\x1b\r',   // same, alternate binding
  'ctrl+k':      '\x0c',     // example: rebind anything
}} />
```

Signature format: lowercase modifiers in the order `ctrl+alt+shift+meta`, then the key (`event.key.toLowerCase()` — e.g. `enter`, `tab`, `arrowup`, `f1`, `a`, ` `).

The `TerminalView` component **ships no default mapping** — that's deliberate. Hardcoding app-specific bytes inside a generic terminal would break neutral apps (e.g. bash's readline interprets `\x1b\r` as Meta+Enter). The default mapping in `App.tsx` is a *consumer* choice for this specific app. Drop the prop or pass `{}` to disable.

## Origin policy

The server checks the `Origin` header on the WS upgrade. Browsers always send one; non-browser clients (curl, ws CLI tools) typically don't and are allowed through (treated as same-origin). To open the LAN/internet, set `WEB_TERMINAL_ALLOWED_ORIGINS` explicitly or pass `*` to disable the check.

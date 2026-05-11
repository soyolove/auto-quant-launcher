# launcher

A local browser-based launcher for autonomous LLM-agent workspaces. Each "workspace" is an independent git directory with a persistent terminal session attached — meant for running long-lived agents (Claude Code, Cursor CLI, Codex CLI, anything that exposes a TUI over a PTY) without the IDE / window / `tmux` baggage.

Built originally around [Auto-Quant](https://github.com/TraderAlice/Auto-Quant)'s research workflow. The Auto-Quant specifics live entirely in **one bootstrap script** (`server/scripts/bootstrap-auto-quant.sh`); the rest of the codebase doesn't know what a "strategy" or a "backtest" is. Swap the script, target a different harness.

---

## 1. Mental model

```
┌──────────────────────────────── browser (one tab) ───────────────────────────────┐
│  [ sidebar (workspaces) | terminal (PTY) | git log + status | file tree     ]    │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │  HTTP /api/*   WS /pty?ws=<id>
                                         ▼
┌─────────────────────────── launcher server (Node, localhost) ────────────────────┐
│  WorkspaceRegistry    → $LAUNCHER_ROOT/workspaces.json   (single source of truth)│
│  WorkspaceCreator     → spawns bootstrap script with (tag, outDir)               │
│  SessionPool          → Map<wsId, PersistentSession>                             │
│     PersistentSession → PTY lifetime decoupled from any WebSocket                │
│                          ReplayBuffer (ring of bytes, replays on reattach)       │
│                          Auto-respawn on child exit (debounce + circuit breaker) │
│  GitService / FileService → read-only inspection over execFile + fs.readdir      │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
            $HOME/.auto-quant-launcher/          ← state root (env-configurable)
                workspaces.json                  ← registry
                data/                            ← shared files (e.g. *.feather), seeded
                workspaces/<wsId>/               ← one independent clone per workspace
```

Three load-bearing decisions you should know about before touching anything:

1. **PTY lifetime ≠ WebSocket lifetime.** Closing the browser, switching tabs, navigating between workspaces — none of these kill the agent. The PTY lives in `SessionPool` on the server; the browser just attaches/detaches.

2. **Each workspace is an independent git checkout on disk.** Not a branch in a shared repo. This is what makes "run two experiments in parallel" trivial — there's no checkout conflict to worry about.

3. **The launcher knows nothing about your domain.** "What goes inside a workspace" is entirely the bootstrap script's call. The TS code only knows: `tag`, `wsId`, `dir`, `createdAt`. No business logic in the launcher.

---

## 2. Quick start

```bash
pnpm install
pnpm dev
# open http://localhost:5173
```

First boot:
- creates `$HOME/.auto-quant-launcher/` if missing
- seeds `data/` once from `$AQ_TEMPLATE_DIR/user_data/data` (configurable)
- waits for you to click "+ create" in the sidebar

The default command launched inside each workspace is `claude` (Claude Code CLI). To use a different agent, set `WEB_TERMINAL_COMMAND='["cursor","agent"]'` or `'["codex"]'` or whatever, see configuration below.

---

## 3. How to use it

### Create a workspace

In the sidebar, type a tag (e.g. `may1-experiment`) and click `create`. The launcher:
1. validates the tag against `^[a-z0-9][a-z0-9_-]{0,32}$`
2. invokes the bootstrap script with `(tag, outDir)` and env `AQ_TEMPLATE_DIR` / `AQ_SHARED_DATA_DIR`
3. on script exit 0, adds the workspace to the registry

The workspace appears in the sidebar. Click it to enter.

### Enter a workspace

Clicking a workspace mounts:
- **Terminal pane** — embedded xterm.js, opens a WS to `/pty?ws=<id>`, server spawns `WEB_TERMINAL_COMMAND` in the workspace dir, full replay buffer is sent so you immediately see the agent's current state (not a black screen)
- **Git panel** — last 30 commits + current `git status`, polls every 3 s. Shows the agent's commit history live
- **Files panel** — single-level file tree with breadcrumb navigation; click directories to descend; polls every 5 s

### Leave it running

Close the browser tab. Close the laptop. Walk away. The PTY keeps running on the server. When you come back, navigate to the same workspace and the terminal renders the full buffer (up to `WEB_TERMINAL_REPLAY_BYTES`, default 512 KiB) so you see what happened in your absence.

### Multiple workspaces, parallel

Make as many workspaces as you want. Each gets its own PTY, its own git history, its own claude/cursor/codex process. The sidebar shows a green dot when the agent is running; gray when idle.

### Delete a workspace

The `×` next to a workspace removes it from the registry **but does NOT delete the directory on disk** — multi-hour research traces are too expensive to nuke on a click. To actually delete files: `DELETE /api/workspaces/<id>?purge=true`.

---

## 4. File layout

```
server/
  scripts/
    bootstrap-auto-quant.sh        ← THE extension point. All Auto-Quant-specific
                                      knowledge lives here. Replace this file to
                                      retarget the launcher to a different harness.
    fix-pty-perms.mjs              ← postinstall: chmod +x node-pty's spawn-helper
  src/
    index.ts                       ← HTTP + WS entrypoint, routes /api/* and /pty
    config.ts                      ← env → typed ServerConfig
    spawn-env.ts                   ← strips terminal-id env leaks (TERM_PROGRAM=vscode etc).
                                      Important: without this, claude-code spawned from a
                                      VSCode-launched shell sees CLAUDE_CODE_SSE_PORT and
                                      tries to route input through the wrong VSCode.
    workspace-registry.ts          ← atomic JSON read/write of workspaces.json
    workspace-creator.ts           ← shells out to bootstrap script with timeout
    bootstrap-data.ts              ← seeds AQ_SHARED_DATA_DIR on first boot
    persistent-session.ts          ← PTY + ReplayBuffer + ws attach/detach + auto-respawn
    session-pool.ts                ← Map<wsId, PersistentSession>; attach/dispose entry points
    replay-buffer.ts               ← ring of Buffer chunks + monotonic seq
    git-service.ts                 ← execFile('git', ...) for log + status
    file-service.ts                ← fs.readdir + lstat, with path-traversal guard
    protocol.ts                    ← wire protocol types + runtime validator
    logger.ts                      ← JSON-line structured logger, hand-rolled (~50 LOC)
  package.json
  tsconfig.json

client/
  src/
    main.tsx                       ← entry; StrictMode INTENTIONALLY OFF (see comment in
                                      file for why — TL;DR double-mount race with WS kicks)
    App.tsx                        ← two-pane shell; owns workspace-list state + hash route
    Sidebar.tsx                    ← workspace list + create form + delete button
    WorkspaceView.tsx              ← layout: terminal (left) + git/files panels (right)
    Terminal.tsx                   ← xterm.js wrapper. Always cold-attach (no `since` param,
                                      no localStorage lastSeq — see comment for why)
    GitPanel.tsx / FilesPanel.tsx
    api.ts                         ← typed fetch wrappers
    protocol.ts                    ← mirrors server/src/protocol.ts
    theme.ts                       ← xterm dark theme
  index.html
  vite.config.ts                   ← proxies /api and /pty to server (default 8787)
  package.json
  tsconfig.json + tsconfig.node.json

pnpm-workspace.yaml                ← root, declares server + client packages
package.json                       ← root, scripts: dev / build / typecheck
.npmrc                             ← enable-pre-post-scripts=true (for fix-pty-perms)
tsconfig.base.json                 ← strict TS settings shared by both packages
```

---

## 5. Templates — the extension point

Everything domain-specific lives in **one directory per template** under `server/templates/`. The launcher's TypeScript code knows nothing about strategies, branches, MCP servers, or chats — that knowledge is encoded as a `bootstrap.sh` (plus optional static asset files) per template.

```
server/templates/
  <name>/
    bootstrap.sh          # required; +x
    template.json         # optional; { "description": "…" }
    files/                # optional; static assets the script can `cp` from
      …
```

Two ship with the launcher:

- **`auto-quant/`** — the original Auto-Quant flow (git clone --local, autoresearch branch, symlinked data, results.tsv header)
- **`chat/`** — a minimal git directory with a `CLAUDE.md` persona and a `.mcp.json` pointing at the test MCP server (`server/scripts/mcp-test-server.mjs`). The end-to-end proof that MCP injection works (see §6).

The Sidebar's "+ create" form shows a template dropdown whenever more than one template is loaded; the default is `chat` if present, else first alphabetical.

### Bootstrap script contract

When you create a workspace with tag `T` and template `tpl`, the launcher invokes:

```bash
server/templates/<tpl>/bootstrap.sh   T   <outDir>
```

with these env vars set:

| Env var | Meaning |
| ------- | ------- |
| `AQ_TEMPLATE_FILES_DIR` | Absolute path to this template's `files/` directory. Use `cp $AQ_TEMPLATE_FILES_DIR/foo $OUT_DIR/foo` to drop static assets in. |
| `AQ_LAUNCHER_REPO_ROOT` | Absolute path to the launcher repo root. Useful when you want `.mcp.json` to reference launcher-shipped scripts (e.g. `$AQ_LAUNCHER_REPO_ROOT/server/scripts/mcp-test-server.mjs`). |
| `AQ_TEMPLATE_DIR` | Auto-Quant-specific; only meaningful for the auto-quant template. The Auto-Quant source dir to clone from. |
| `AQ_SHARED_DATA_DIR` | Auto-Quant-specific; the shared `*.feather` directory. |

The script must produce a workspace at `$OUT_DIR` and exit 0. Non-zero exit becomes `{ error: "bootstrap_failed", stderr: "…" }` to the API caller. The launcher does no further validation — it just registers `{ id, tag, dir, createdAt, template }` after success.

### Adding a new template

```bash
mkdir -p server/templates/my-task/files
cp server/templates/chat/bootstrap.sh server/templates/my-task/bootstrap.sh   # start from the chat template
$EDITOR server/templates/my-task/bootstrap.sh                                 # adjust whatever assets you copy
echo '{"description":"My custom task workspace"}' > server/templates/my-task/template.json
# Add files/CLAUDE.md, files/mcp.json, etc. as needed.
```

Restart the server. New template shows up in `GET /api/templates` and in the sidebar dropdown automatically.

### Legacy: single-script mode

`AQ_BOOTSTRAP_SCRIPT=/path/to/script.sh` is still honored — registered as a synthetic template named `legacy`. The launcher logs a warning and keeps working, but the recommended migration is to move the script under `server/templates/<name>/bootstrap.sh` and delete the env var.

---

## 6. MCP injection (the OpenAlice integration story)

The launcher itself knows nothing about MCP. The mechanism is simple:

1. A workspace template ships a `.mcp.json` (Claude Code's project-scope config) under its `files/` directory
2. The bootstrap script `cp`s that file into the workspace verbatim
3. When the launcher later spawns Claude Code in the workspace cwd, Claude Code reads `.mcp.json`, expands `${VAR}` placeholders against its process env, and connects

**The load-bearing detail**: those `${VAR}` placeholders are expanded by **Claude Code at session start**, not by the bootstrap script at workspace creation. The launcher injects the right env into Claude's process via `spawn-env.ts` (specifically `AQ_LAUNCHER_REPO_ROOT` and `AQ_WS_ID`). Bootstrap env doesn't reach Claude because by then bootstrap has long since exited.

### The shipped chat template (read this; the OpenAlice integration is one find/replace away)

`server/templates/chat/files/mcp.json`:

```json
{
  "mcpServers": {
    "launcher-test": {
      "type": "stdio",
      "command": "node",
      "args": ["${AQ_LAUNCHER_REPO_ROOT}/server/scripts/mcp-test-server.mjs"],
      "env": {
        "WS_ID": "${AQ_WS_ID:-unknown}"
      }
    }
  }
}
```

`server/templates/chat/bootstrap.sh` (the relevant lines):

```bash
cp "$AQ_TEMPLATE_FILES_DIR/mcp.json" .mcp.json
cp "$AQ_TEMPLATE_FILES_DIR/CLAUDE.md" CLAUDE.md
git init -q && git add . && git -c user.email=launcher@local commit -q -m "chat: $TAG"
```

The bootstrap **does not** expand `${AQ_LAUNCHER_REPO_ROOT}` — `cp` preserves it literally. Claude Code's docs explicitly support `${VAR}` and `${VAR:-default}` syntax in `command` / `args` / `env` / `url` / `headers`, expanded at session start.

End-to-end verification (already done, see `server/scripts/mcp-test-client.mjs` for standalone): create a chat workspace, attach, click "Trust this folder", run `/mcp` — `launcher-test · ✓ connected · 1 tool`. Ask Claude to call `introduce_self` — response is `I am the launcher-test MCP server. workspace WS_ID=<the workspace's UUID>`.

### Pointing at OpenAlice's MCP server (or anyone else's)

To replace the test server with OpenAlice's (or any domain backend's) MCP server, **fork the chat template and edit `files/mcp.json`**:

**Option A: stdio (Claude Code spawns the MCP server)**

```json
{
  "mcpServers": {
    "openalice": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/openalice/dist/mcp-server.js"],
      "env": {
        "OPENALICE_DATA_DIR": "${HOME}/.openalice",
        "WS_ID": "${AQ_WS_ID:-unknown}"
      }
    }
  }
}
```

If OpenAlice ships with the launcher, prefer `${AQ_LAUNCHER_REPO_ROOT}/<relative-path-to-mcp-server>` so the config is portable across clones.

**Option B: HTTP / SSE (OpenAlice is already running, Claude Code connects)**

```json
{
  "mcpServers": {
    "openalice": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3002/mcp",
      "headers": {
        "Authorization": "Bearer ${OPENALICE_TOKEN}"
      }
    }
  }
}
```

This shape is what we expect for OpenAlice's current architecture: OpenAlice is a long-running local server that exposes MCP over HTTP. The launcher's job is just to drop the right `.mcp.json` into workspaces.

### Adding your own env-var placeholders

If you need a new `${MY_VAR}` to be expandable in a template's `.mcp.json`, set it in `server/src/index.ts`'s `SessionPool` factory:

```ts
env: buildSpawnEnv(process.env, {
  AQ_WS_ID: wsId,
  AQ_LAUNCHER_REPO_ROOT: config.launcherRepoRoot,
  MY_VAR: 'whatever',          // ← add here
}),
```

`buildSpawnEnv`'s `extras` parameter exists precisely for this — caller-supplied per-session env overlay.

### Claude Code MCP gotchas (paid for in blood, listed here so you don't have to)

- **`.mcp.json` triggers a trust prompt** on first attach to a project-scope workspace. There's no `--mcp-trust` flag; the user clicks once per workspace. To reset the choice, run `claude mcp reset-project-choices` inside the workspace.
- **stdio MCP servers must not write to stderr during startup**. Claude Code treats any stderr noise during the handshake as a failed connection and the server appears as disconnected forever (or until you fix it and reattach). Don't add `console.error('starting')` "for debug".
- **`type` is required** in each `mcpServers.<name>` entry (`stdio` / `streamable-http` / `sse`). Skipping it silently breaks the entry.
- **The MCP server name `workspace` is reserved**. Pick anything else.
- **Path resolution for `command` and `args` is not specified by docs** to be relative-to-anything. Always use absolute paths, ideally via `${AQ_LAUNCHER_REPO_ROOT}` expansion so the config remains portable.

Reference: https://code.claude.com/docs/en/mcp

### What the launcher does NOT do (deliberately)

- Doesn't run the MCP server itself. That's the responsibility of whoever owns the domain backend.
- Doesn't manage MCP-server lifecycle. If the MCP server is down, Claude Code shows the failed connection in `/mcp`; restart the backend, then `/mcp` to refresh.
- Doesn't validate `.mcp.json` contents. Claude Code rejects malformed configs at startup.
- Doesn't pre-approve MCP server trust. The user clicks once.

---

## 7. Configuration reference (env)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `8787` | Server listen port |
| `HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for LAN — also set allowed origins!) |
| `AQ_LAUNCHER_ROOT` | `$HOME/.auto-quant-launcher` | State root |
| `AQ_TEMPLATES_DIR` | `server/templates/` | Templates root. Each subdir = one template. |
| `AQ_TEMPLATE_DIR` | `/Users/ame/2605dev/Auto-Quant` | Auto-Quant-specific: source dir the `auto-quant` template clones from |
| `AQ_SHARED_DATA_DIR` | `$LAUNCHER_ROOT/data` | Auto-Quant-specific: shared `*.feather` dir the `auto-quant` template symlinks into |
| `AQ_BOOTSTRAP_SCRIPT` | (unset) | Legacy single-script mode. Honored as a synthetic `legacy` template; prefer migrating to `$AQ_TEMPLATES_DIR/<name>/bootstrap.sh`. |
| `AQ_BOOTSTRAP_TIMEOUT_MS` | `60000` | Bootstrap script kill timeout |
| `WEB_TERMINAL_COMMAND` | `["claude"]` | What to spawn inside each workspace. JSON array or whitespace-split argv |
| `WEB_TERMINAL_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | WS upgrade Origin allowlist, or `*` to disable |
| `WEB_TERMINAL_REPLAY_BYTES` | `524288` | Per-session ring buffer cap |
| `WEB_TERMINAL_BP_HIGH` / `BP_LOW` | `1048576` / `262144` | WS backpressure watermarks |
| `WEB_TERMINAL_SHUTDOWN_MS` | `5000` | SIGTERM/SIGINT clean-shutdown timeout |
| `WEB_TERMINAL_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

---

## 8. HTTP API

All under `/api`, JSON in/out, 127.0.0.1 only (unless `HOST` and `WEB_TERMINAL_ALLOWED_ORIGINS` are configured otherwise).

| Method | Path | Body / Query | Response |
| ------ | ---- | ------------ | -------- |
| `GET` | `/api/templates` | — | `{ templates: [{ name, description? }] }` |
| `GET` | `/api/workspaces` | — | `{ workspaces: WorkspaceMeta[] }`, each with `claudeRunning: boolean` derived from `SessionPool` |
| `POST` | `/api/workspaces` | `{ tag: string, template?: string }` | `201 { workspace }` / `400 invalid_tag \| unknown_template` / `409 tag_in_use` / `500 bootstrap_failed { stderr }`. Omitting `template` uses `chat` (default if present) or first alphabetical template. |
| `DELETE` | `/api/workspaces/:id` | `?purge=true` optional | `200 { ok: true, purged: bool }` (default keeps dir, `?purge=true` rm -rf's it) |
| `GET` | `/api/workspaces/:id/git/log` | `?limit=30` | `{ entries: [{ hash, subject, relTime, authorTime }] }` |
| `GET` | `/api/workspaces/:id/git/status` | — | `{ branch, clean, files: [{ path, status }] }` (porcelain v1 two-char codes) |
| `GET` | `/api/workspaces/:id/files` | `?path=user_data/strategies` | `{ path, entries: [{ name, kind, sizeBytes, mtime }] }` — single level, no recursion |
| `GET` | `/healthz` | — | `{ ok: true }` |

```ts
type WorkspaceMeta = {
  id: string;            // UUID
  tag: string;           // user-supplied, validated against ^[a-z0-9][a-z0-9_-]{0,32}$
  dir: string;           // absolute path
  createdAt: string;     // ISO timestamp
  template?: string;     // template the workspace was bootstrapped from (absent on legacy entries)
  claudeRunning: boolean;  // computed from pool
};
```

---

## 9. WebSocket protocol

URL: `ws://host/pty?ws=<wsId>&cols=N&rows=N`

Frame contract:
- **Binary frames** carry raw PTY bytes (both directions). No re-encoding on the server — xterm.js handles streaming UTF-8 decode on the client, so CJK / emoji split across kernel `read()` boundaries don't produce mojibake.
- **Text frames** carry JSON control messages:

```ts
// client → server
type ClientControl =
  | { type: 'resize'; cols: number; rows: number }
  // `attach` is also a defined type but the URL query is sufficient for the
  // initial attach — clients don't need to send it.
;

// server → client
type ServerControl =
  | { type: 'attached'; wsId; pid; command; replayFromSeq; seq; scrollbackTruncated }
  | { type: 'cursor'; seq }                          // periodic heartbeat
  | { type: 'lifecycle'; kind: 'child-exit'; code; signal }
  | { type: 'lifecycle'; kind: 'child-respawn'; pid }  // after auto-respawn
  | { type: 'exit'; code; signal }                   // session itself disposed
;
```

Close codes used by the server:
- `1000` — normal close (e.g. session disposed, PTY exited and circuit broke)
- `4000` — `ws=<id>` query parameter missing
- `4001` — kicked by a new attach to the same wsId (only one client per session in v1)
- `4404` — wsId not found in registry

---

## 10. Cherry-pick guidance (for integrators)

If you want to lift this launcher into another project (e.g. OpenAlice), the simplest paths:

### Option A: copy the workspace as-is, swap one template

Clone the two packages (`server/` + `client/`) into your monorepo as new workspaces, adjust `pnpm-workspace.yaml`, and:

1. **Copy the `chat` template** to `server/templates/<your-product>/` and edit `files/mcp.json` to point at your MCP server (see §6 for stdio vs HTTP forms).
2. **Optionally drop the `auto-quant` template** if your product has no use for it.
3. **Defaults to tweak in `server/src/config.ts`**: `AQ_LAUNCHER_ROOT` (where state lives on disk), `AQ_TEMPLATE_DIR` (Auto-Quant-specific, only matters if you keep that template). The `WEB_TERMINAL_*` env var prefix is just historical naming — rename to taste.
4. **Run your MCP server**. The launcher doesn't start it for you.

That's it. The launcher is content-agnostic; the chat-template-with-MCP pattern is the integration story.

### Option B: extract just the persistence/protocol kernel

If the multi-template UI / git / files / sidebar surface isn't what you want, the reusable kernel — useful for any Node + ws project that needs persistent PTY sessions — is:

- `server/src/persistent-session.ts` — PTY decoupled from WS, replay buffer, auto-respawn
- `server/src/session-pool.ts` — per-id session map
- `server/src/replay-buffer.ts` — pure data structure, no deps
- `server/src/protocol.ts` + `client/src/protocol.ts` — the WS protocol
- `server/src/spawn-env.ts` — env sanitization + per-session env injection (you almost certainly want this if spawning CLI agents from a parent shell — see the `TERM_PROGRAM=vscode` / `CLAUDE_CODE_SSE_PORT` saga in the file header)

These five files have no Auto-Quant, no "launcher", no MCP coupling. Drop them in and write your own surrounding code.

### What you probably don't want to copy

- `server/templates/auto-quant/` — Auto-Quant-specific, not yours
- `server/src/bootstrap-data.ts` — Auto-Quant-specific data seeding (the `.feather` files copy on first boot)
- `server/scripts/mcp-test-server.mjs` and `mcp-test-client.mjs` — these are demo / sanity-check; replace with your real MCP server. **Read them for the SDK boilerplate** though — they're the minimal correct shape for a stdio MCP server (no stderr noise on startup, `setRequestHandler` for tools/list + tools/call).
- The sidebar / git panel / files panel UIs as-is — fine for a one-person tool, you'll likely want to redesign for your product surface

---

## 11. Deliberately not built (yet)

- `results.tsv`-as-live-table, sharpe charts, any Auto-Quant-specific visualizations
- Remote access / auth / TLS (localhost only)
- File editing — agent owns its files; we display only
- Workspace import from an existing branch — only "new from template"
- WS auto-reconnect within the same xterm instance (would let `lastSeq` become useful again)
- Push-based file/git updates (currently 3 s polling); see the memory note on REST-vs-WS-multiplexing for when this should flip
- Multi-client per workspace (one attached client at a time; second attach kicks first)
- MCP-server-trust pre-approval — first attach to any workspace prompts the user for `.mcp.json` trust; no `--mcp-trust` flag exists in Claude Code today

---

## Reset

```bash
rm -rf $HOME/.auto-quant-launcher
```

Wipes the registry, all per-workspace clones, and the shared data cache. Next boot re-seeds `data/` from the template.

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

## 5. The bootstrap script contract

This is the **only** extension point. Everything else is launcher infrastructure.

When you click "create" with tag `T`, the launcher invokes:

```bash
$AQ_BOOTSTRAP_SCRIPT  $T  $OUT_DIR
```

with these env vars set:

| Env var | Meaning |
| ------- | ------- |
| `AQ_TEMPLATE_DIR` | What the script should read from (e.g. an Auto-Quant clone, or any source-of-truth dir) |
| `AQ_SHARED_DATA_DIR` | What the script should symlink shared read-only data from |

The script must produce a workspace at `$OUT_DIR` and exit 0. Failure: exit non-zero with a useful message on stderr (the launcher surfaces it to the API caller as `{ error: "bootstrap_failed", stderr: "…" }`).

**Minimal contract**: `$OUT_DIR` exists after script exits and is a directory. The launcher does no further validation — it just registers `{ id, tag, dir, createdAt }`.

**Default script (`bootstrap-auto-quant.sh`)** does:
1. `git clone --local "$AQ_TEMPLATE_DIR" "$OUT_DIR"` — hardlinks `.git/objects`, cheap
2. `git checkout -b "autoresearch/$tag"`
3. Symlink `user_data/data` → `$AQ_SHARED_DATA_DIR`
4. Write `results.tsv` header
5. Add the symlink path to `.git/info/exclude` so it doesn't show as untracked

**To add a new task type**, write a new script (e.g. `scripts/bootstrap-asset-tracking.sh`) that produces a different shape of workspace, then set `AQ_BOOTSTRAP_SCRIPT=/path/to/your/script` and restart the server. Or — better — see §6 below for the multi-template direction.

---

## 6. MCP injection (the integration story)

The launcher has no concept of "MCP" — but because each workspace is just a directory, you can drop standard MCP config files in there and the CLI agent will pick them up.

For Claude Code, this means writing a `.mcp.json` at the workspace root. The launcher should arrange for this file to exist by the time `claude` is spawned in the cwd.

### Recommended pattern

Have your bootstrap script write the `.mcp.json` into the workspace as part of bootstrap. Example for an OpenAlice-style backend exposing tools via MCP:

```bash
# in your bootstrap script, after the dir is set up:
cat > "$OUT_DIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "openalice": {
      "command": "node",
      "args": ["$OPENALICE_MCP_BIN", "--port=stdio"]
    }
  }
}
EOF
```

Or for an HTTP/SSE-based MCP server already running locally:

```json
{
  "mcpServers": {
    "openalice": {
      "url": "http://localhost:3002/mcp"
    }
  }
}
```

When `claude` (or any MCP-capable CLI) starts in this workspace, it reads `.mcp.json`, connects to the MCP server, and the agent immediately has all of OpenAlice's exposed tools available — `list_utas`, `get_snapshot`, `stage_order`, etc.

### What the launcher does NOT do (deliberately)

- Doesn't run the MCP server itself. That's the responsibility of whoever owns the domain backend (OpenAlice, etc.)
- Doesn't manage MCP-server lifecycle. If OpenAlice's MCP server isn't running, the agent inside the workspace will see connection errors — fix it by starting OpenAlice
- Doesn't validate the `.mcp.json` contents. The CLI agent will reject malformed configs at startup

### Multi-template roadmap (not built yet)

To support multiple kinds of task workspace (`auto-quant`, `asset-tracking`, `macro-weekly`, …) without env-var swapping, the planned shape is:

```
$LAUNCHER_ROOT/templates/
  auto-quant/
    bootstrap.sh
    CLAUDE.md.tmpl
    .mcp.json.tmpl
  asset-tracking/
    bootstrap.sh
    CLAUDE.md.tmpl
    .mcp.json.tmpl
  …

# API extension:
POST /api/workspaces  body: { tag, template: "asset-tracking", params: {...} }
```

The bootstrap script per template renders the `.tmpl` files into the workspace with the params substituted. Sidebar "+" becomes a dropdown of templates. This is a few hours of work and **not done yet** — if you (or the integrator) need it, that's the place to add.

---

## 7. Configuration reference (env)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `8787` | Server listen port |
| `HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for LAN — also set allowed origins!) |
| `AQ_LAUNCHER_ROOT` | `$HOME/.auto-quant-launcher` | State root |
| `AQ_TEMPLATE_DIR` | `/Users/ame/2605dev/Auto-Quant` | Source dir for bootstrap script |
| `AQ_SHARED_DATA_DIR` | `$LAUNCHER_ROOT/data` | Shared read-only data dir (`*.feather` etc.) |
| `AQ_BOOTSTRAP_SCRIPT` | `server/scripts/bootstrap-auto-quant.sh` | Script invoked on workspace create |
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
| `GET` | `/api/workspaces` | — | `{ workspaces: WorkspaceMeta[] }`, each with `claudeRunning: boolean` derived from `SessionPool` |
| `POST` | `/api/workspaces` | `{ tag: string }` | `201 { workspace }` / `400 invalid_tag` / `409 tag_in_use` / `500 bootstrap_failed { stderr }` |
| `DELETE` | `/api/workspaces/:id` | `?purge=true` optional | `200 { ok: true, purged: bool }` (default keeps dir, `?purge=true` rm -rf's it) |
| `GET` | `/api/workspaces/:id/git/log` | `?limit=30` | `{ entries: [{ hash, subject, relTime, authorTime }] }` |
| `GET` | `/api/workspaces/:id/git/status` | — | `{ branch, clean, files: [{ path, status }] }` (porcelain v1 two-char codes) |
| `GET` | `/api/workspaces/:id/files` | `?path=user_data/strategies` | `{ path, entries: [{ name, kind, sizeBytes, mtime }] }` — single level, no recursion |
| `GET` | `/healthz` | — | `{ ok: true }` |

```ts
type WorkspaceMeta = {
  id: string;            // UUID
  tag: string;           // user-supplied
  dir: string;           // absolute path
  createdAt: string;     // ISO timestamp
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

### Option A: copy the workspace as-is

Clone the two packages (`server/` + `client/`) into your monorepo as new workspaces. Adjust `pnpm-workspace.yaml`. Point `AQ_BOOTSTRAP_SCRIPT` at your own bootstrap script that knows your domain. Done.

What you'll need to change:
- `AQ_LAUNCHER_ROOT` default in `server/src/config.ts` (or just set the env)
- `AQ_TEMPLATE_DIR` default in `server/src/config.ts`
- Optionally rename: the `WEB_TERMINAL_*` env var prefix and the `auto-quant-launcher` storage dir name aren't load-bearing, just historical

### Option B: extract just the persistence/protocol layer

The interesting reusable kernel is:

- `server/src/persistent-session.ts` — PTY decoupled from WS, replay buffer, auto-respawn
- `server/src/session-pool.ts` — per-id session map
- `server/src/replay-buffer.ts` — pure data structure, no deps
- `server/src/protocol.ts` + `client/src/protocol.ts` — the WS protocol
- `server/src/spawn-env.ts` — env sanitization (you almost certainly want this if spawning CLI agents from a parent shell)

These have no Auto-Quant or even "launcher" coupling. Drop them into any Node + ws project that needs persistent PTY sessions.

### What you probably don't want to copy

- `bootstrap-auto-quant.sh` — write your own
- `server/src/bootstrap-data.ts` — Auto-Quant-specific data seeding
- The sidebar / git panel / files panel UIs as-is — they're fine but you'll likely want to redesign for your product surface

---

## 11. Deliberately not built (yet)

- Multi-template UI (sidebar dropdown of task types) — see §6
- `results.tsv`-as-live-table, sharpe charts, any Auto-Quant-specific visualizations
- Remote access / auth / TLS (localhost only)
- File editing — agent owns its files; we display only
- Workspace import from an existing branch — only "new from template"
- WS auto-reconnect within the same xterm instance (would let `lastSeq` become useful again)
- Push-based file/git updates (currently 3 s polling); see the memory note on REST-vs-WS-multiplexing for when this should flip
- Multi-client per workspace (one attached client at a time; second attach kicks first)

---

## Reset

```bash
rm -rf $HOME/.auto-quant-launcher
```

Wipes the registry, all per-workspace clones, and the shared data cache. Next boot re-seeds `data/` from the template.

# auto-quant launcher

A local browser-based launcher for autonomous LLM agent loops. Built initially around [Auto-Quant](https://github.com/TraderAlice/Auto-Quant)'s research workflow: each "workspace" is a self-contained git checkout with its own branch + agent session.

**Mental model**: a simplified VSCode optimised for small Harness-shaped projects. The launcher owns the lifecycle (workspace creation, navigation, supervision); the embedded web-terminal is where the agent actually runs.

```
┌─────────── browser ──────────────────────────────────────────────┐
│  [ sidebar │ terminal           │ git log    ]                   │
│            │                    │ git status │                   │
│            │                    │ file tree  │                   │
└─────────────────────────────────┬────────────────────────────────┘
                                  │  HTTP /api/*    WS /pty?ws=…
                                  ▼
┌─────────── launcher server (Node, localhost) ────────────────────┐
│  WorkspaceRegistry  →  $LAUNCHER_ROOT/workspaces.json            │
│  WorkspaceCreator   →  shells out to a configurable bootstrap    │
│  SessionPool        →  one PersistentSession per wsId            │
│                        PTY survives WS disconnect, ring-buffer   │
│                        replay on reattach, auto-respawn on crash │
│  GitService / FileService  →  read-only `git -C` + readdir       │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  ▼
        $HOME/.auto-quant-launcher/
            workspaces.json
            data/             ← shared *.feather (seeded once from template)
            workspaces/<id>/  ← one independent Auto-Quant clone per workspace
```

## Why it exists

`Auto-Quant`'s README literally tells you to "open a second terminal" for the agent. That works for one experiment at a time on your laptop. Doesn't work if you want:

- multiple parallel runs (manual `git checkout` between them is footguns galore)
- to close the IDE / put the machine to sleep without killing the agent
- to monitor from another room or another device
- to glance at *what changed* lately without staring at the agent's character stream

The launcher solves all four. PTY lives server-side, navigation is by workspace, monitoring is glanceable.

## Quick start

```bash
pnpm install
pnpm dev
# open http://localhost:5173
```

First boot: the launcher creates `$HOME/.auto-quant-launcher/`, seeds `data/` from your `AQ_TEMPLATE_DIR` (default `/Users/ame/2605dev/Auto-Quant`) once, and waits. Use the sidebar to create your first workspace.

## Scripts

- `pnpm dev` — server + client in parallel.
- `pnpm build` — typecheck + build.
- `pnpm typecheck` — strict typecheck, no emit.

## Configuration (env)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `8787` | Server listen port. |
| `HOST` | `127.0.0.1` | Bind address. |
| `AQ_LAUNCHER_ROOT` | `$HOME/.auto-quant-launcher` | Server state root. |
| `AQ_TEMPLATE_DIR` | `/Users/ame/2605dev/Auto-Quant` | Where to `git clone --local` workspaces from. |
| `AQ_SHARED_DATA_DIR` | `$LAUNCHER_ROOT/data` | Holds `.feather` files; each workspace symlinks `user_data/data` here. |
| `AQ_BOOTSTRAP_SCRIPT` | `server/scripts/bootstrap-auto-quant.sh` | Script the launcher invokes on workspace creation. |
| `AQ_BOOTSTRAP_TIMEOUT_MS` | `60000` | Bootstrap script kill timeout. |
| `WEB_TERMINAL_COMMAND` | `["claude"]` | What the PTY launches inside each workspace. JSON array or whitespace argv. |
| `WEB_TERMINAL_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | WS-upgrade Origin allowlist (or `*`). |
| `WEB_TERMINAL_REPLAY_BYTES` | `524288` | Per-session output ring-buffer cap. |
| `WEB_TERMINAL_BP_HIGH` / `BP_LOW` | `1048576` / `262144` | WS backpressure watermarks. |
| `WEB_TERMINAL_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |

## Bootstrap script contract

The launcher itself knows nothing about git, branches, or `results.tsv` — that knowledge lives in `AQ_BOOTSTRAP_SCRIPT`. When you create a workspace, the launcher invokes:

```
$AQ_BOOTSTRAP_SCRIPT <tag> <outDir>
```

with these env vars set:

- `AQ_TEMPLATE_DIR` — path to the Auto-Quant clone the script should read from
- `AQ_SHARED_DATA_DIR` — path the script should symlink `user_data/data` into

The script must produce a workspace at `<outDir>` and exit 0. Failure: exit non-zero with a useful message on stderr (the launcher surfaces it to the API caller).

The default `server/scripts/bootstrap-auto-quant.sh` does:
1. `git clone --local "$AQ_TEMPLATE_DIR" "$outDir"` (hardlinks `.git/objects`, cheap)
2. `git checkout -b "autoresearch/$tag"`
3. Symlinks `user_data/data` → `$AQ_SHARED_DATA_DIR`
4. Writes `results.tsv` header
5. Adds the symlink path to `.git/info/exclude` so it doesn't appear as untracked

Swap this script (point `AQ_BOOTSTRAP_SCRIPT` elsewhere) to bootstrap a different shape of harness — the launcher doesn't care.

## API

All under `/api/`, JSON, 127.0.0.1 only.

| Method | Path | Meaning |
| ------ | ---- | ------- |
| `GET` | `/api/workspaces` | List all workspaces with `claudeRunning` derived from the SessionPool. |
| `POST` | `/api/workspaces` | Body `{ "tag": "..." }`. 201 / 409 (`tag_in_use`) / 400 (`invalid_tag`). |
| `DELETE` | `/api/workspaces/:id` | Deregister; `?purge=true` also `rm -rf`s the directory. |
| `GET` | `/api/workspaces/:id/git/log?limit=N` | Last N commits, hash/subject/relTime/authorTime. |
| `GET` | `/api/workspaces/:id/git/status` | Current branch + porcelain file list. |
| `GET` | `/api/workspaces/:id/files?path=…` | One level of directory listing (no recursion). |

WebSocket: `ws://host/pty?ws=<id>&cols=N&rows=N&since=<seq>`. `since` is optional; absent = cold attach with no replay.

## Wire protocol (terminal)

Binary frames carry raw PTY bytes both directions (no UTF-8 round-trip on the server side; xterm.js's streaming decoder handles CJK / emoji across read boundaries).

Text frames carry JSON control messages:

- C→S: `{type:"resize",cols,rows}` (`attach` is also defined but the URL query is sufficient — client doesn't need to send it).
- S→C: `attached` (after WS open), `cursor` (heartbeat for `lastSeq`), `lifecycle` (`child-exit` / `child-respawn`), `exit` (only when the session itself goes away).

`lastSeq` is persisted per-wsId in `localStorage` so a browser reload reattaches and replays the missed window.

## Reset

To start over from scratch:

```bash
rm -rf $HOME/.auto-quant-launcher
```

This wipes the registry, all per-workspace clones, and the shared data cache. Next launcher boot re-seeds `data/` from the template.

## What's deliberately not here yet

- `results.tsv` rendered as a live table, Sharpe trajectory chart, per-strategy analysis — too early to commit to a UI for these
- Multi-user / remote access / auth / TLS — localhost only
- File editing — the agent owns the files; we display only
- Workspace import from an existing branch — only "new from template"
- Generalised harness schema — Auto-Quant constants live in the bootstrap script; swap the script to retarget

## Layout

```
server/
  scripts/bootstrap-auto-quant.sh   ← the lifecycle knowledge
  src/
    index.ts                        ← HTTP + WS entrypoint
    config.ts                       ← env → typed config
    spawn-env.ts                    ← strips terminal-id env leaks (TERM_PROGRAM=vscode etc)
    workspace-registry.ts           ← atomic JSON store
    workspace-creator.ts            ← spawns bootstrap script
    bootstrap-data.ts               ← seeds shared data dir on first boot
    persistent-session.ts           ← PTY-decoupled-from-WS, replay buffer, auto-respawn
    session-pool.ts                 ← Map<wsId, PersistentSession>
    replay-buffer.ts                ← ring of bytes + monotonic seq
    git-service.ts / file-service.ts ← read-only inspection
    protocol.ts / logger.ts
client/
  src/
    App.tsx + App.css               ← two-pane shell, hash routing
    Sidebar.tsx                     ← workspace list + "New" form
    WorkspaceView.tsx               ← terminal + git/files panels
    Terminal.tsx + theme.ts         ← xterm.js wrapper with keyMap
    GitPanel.tsx / FilesPanel.tsx
    api.ts / protocol.ts
```

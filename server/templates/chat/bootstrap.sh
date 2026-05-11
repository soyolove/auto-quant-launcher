#!/usr/bin/env bash
# Bootstrap a chat workspace: an empty git directory with .mcp.json and
# CLAUDE.md dropped in from the template's files/ directory. The launcher
# spawns claude (or whatever WEB_TERMINAL_COMMAND points at) in here on
# attach; it sees .mcp.json and tries to connect to the listed MCP servers
# after the trust prompt.
#
# Contract:
#   argv:  $1 = tag, $2 = outDir
#   env:   AQ_TEMPLATE_FILES_DIR  — absolute path to this template's files/
# exit:  0 ok, non-zero on any failure

set -euo pipefail

TAG="${1:?tag required}"
OUT_DIR="${2:?outDir required}"
: "${AQ_TEMPLATE_FILES_DIR:?AQ_TEMPLATE_FILES_DIR must be set by the launcher}"

if [[ -e "$OUT_DIR" ]]; then
  echo "outDir already exists: $OUT_DIR" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

# Copy the static template assets verbatim. We deliberately do NOT use
# heredoc / envsubst — the .mcp.json contains ${AQ_LAUNCHER_REPO_ROOT}
# placeholders that must reach disk unexpanded, so Claude Code expands them
# at its own startup using the env we set in spawn-env.ts.
cp "$AQ_TEMPLATE_FILES_DIR/mcp.json" .mcp.json
cp "$AQ_TEMPLATE_FILES_DIR/CLAUDE.md" CLAUDE.md

git init -q
git add .
git -c user.email=launcher@local -c user.name=launcher commit -q -m "chat: $TAG"

echo "bootstrapped chat workspace '$TAG' at $OUT_DIR"

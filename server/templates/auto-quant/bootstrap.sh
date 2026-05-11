#!/usr/bin/env bash
# Default bootstrap script for Auto-Quant workspaces.
#
# Contract with the launcher (workspace-creator.ts):
#   argv:  $1 = tag (validated by the launcher: ^[a-z0-9][a-z0-9_-]{0,32}$)
#          $2 = outDir (absolute path the launcher wants the workspace at)
#   env:   AQ_TEMPLATE_DIR        — Auto-Quant repo to clone --local from
#          AQ_SHARED_DATA_DIR     — directory holding the *.feather files to share
#   exit:  0 on success, non-zero on any failure (stderr surfaces to the API caller)
#
# This file IS the source of truth for what an Auto-Quant workspace looks
# like on disk. The TypeScript launcher knows nothing about branches,
# results.tsv, or symlinks — only that this script exited 0 and outDir now
# exists. Tweak it freely, or point AQ_BOOTSTRAP_SCRIPT at your own copy.

set -euo pipefail

TAG="${1:?tag required}"
OUT_DIR="${2:?outDir required}"

: "${AQ_TEMPLATE_DIR:?AQ_TEMPLATE_DIR must point at an Auto-Quant clone}"
: "${AQ_SHARED_DATA_DIR:?AQ_SHARED_DATA_DIR must point at the shared data/ directory}"

if [[ -e "$OUT_DIR" ]]; then
  echo "outDir already exists: $OUT_DIR" >&2
  exit 2
fi

if [[ ! -d "$AQ_TEMPLATE_DIR/.git" ]]; then
  echo "AQ_TEMPLATE_DIR is not a git repo: $AQ_TEMPLATE_DIR" >&2
  exit 3
fi

# 1. local clone — hardlinks .git/objects, fast and disk-cheap.
git clone --local "$AQ_TEMPLATE_DIR" "$OUT_DIR" >/dev/null

cd "$OUT_DIR"

# 2. autoresearch branch from whatever master/main the template points at.
git checkout -b "autoresearch/$TAG" >/dev/null

# 3. share the read-only *.feather data via symlink (gitignored path,
#    so git itself won't complain).
mkdir -p user_data
rm -rf user_data/data
ln -s "$AQ_SHARED_DATA_DIR" user_data/data

# Auto-Quant's .gitignore has `user_data/data/` (trailing slash = dir-only),
# which doesn't match the symlink file at `user_data/data`. Add a per-clone
# exclude so the launcher's "git status" panel doesn't carry that noise row.
echo 'user_data/data' >> .git/info/exclude

# 4. results.tsv header — the agent appends rows from here on out.
printf 'commit\tevent\tstrategy_name\tsharpe\tmax_dd\tnote\n' > results.tsv

echo "bootstrapped autoresearch/$TAG at $OUT_DIR"

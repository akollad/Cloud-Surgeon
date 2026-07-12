#!/bin/bash
# Post-merge setup — runs after every task merge.
# Must be idempotent, non-interactive, and fast.
set -e

echo "=== [post-merge] Installing dependencies ==="
pnpm install --frozen-lockfile

echo "=== [post-merge] Installing ccloud CLI (CockroachDB Cloud CLI) ==="
TOOLS_DIR="$PWD/.tools"
mkdir -p "$TOOLS_DIR"
if [ ! -f "$TOOLS_DIR/ccloud" ]; then
  curl -fsSL https://binaries.cockroachdb.com/ccloud/ccloud_linux-amd64_0.6.12.tar.gz \
    | tar -xz -C "$TOOLS_DIR"
  echo "  ccloud $($TOOLS_DIR/ccloud version 2>&1 | head -1) installed"
else
  echo "  ccloud already present ($($TOOLS_DIR/ccloud version 2>&1 | head -1))"
fi

echo "=== [post-merge] Building API server ==="
pnpm --filter @workspace/api-server run build

echo "=== [post-merge] Done ==="
# NOTE: drizzle-kit push is intentionally omitted.
# CockroachDB DDL is managed via idempotent raw SQL at server startup
# (createMetricSnapshotsTable and other init helpers in index.ts).
# Adding new tables: add a pool.query CREATE TABLE IF NOT EXISTS call in
# artifacts/api-server/src/index.ts — it runs automatically on next restart.

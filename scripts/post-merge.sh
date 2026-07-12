#!/bin/bash
# Post-merge setup — runs after every task merge.
# Must be idempotent, non-interactive, and fast.
set -e

echo "=== [post-merge] Installing dependencies ==="
pnpm install --frozen-lockfile

echo "=== [post-merge] Building API server ==="
pnpm --filter @workspace/api-server run build

echo "=== [post-merge] Done ==="
# NOTE: drizzle-kit push is intentionally omitted.
# CockroachDB DDL is managed via idempotent raw SQL at server startup
# (createMetricSnapshotsTable and other init helpers in index.ts).
# Adding new tables: add a pool.query CREATE TABLE IF NOT EXISTS call in
# artifacts/api-server/src/index.ts — it runs automatically on next restart.

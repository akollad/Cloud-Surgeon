# Cloud-Surgeon

> Autonomous AI DevOps agent — detects, diagnoses, and repairs cloud infrastructure incidents using a three-layer CockroachDB memory system that learns from every repair.

Built for the **CockroachDB × AWS Hackathon 2026**.

---

## How to run

Two services start automatically via Replit workflows:

| Service | Workflow | Preview |
|---|---|---|
| API Server (Express 5 / TypeScript) | `artifacts/api-server: API Server` | `/api` |
| React Dashboard | `artifacts/dashboard: web` | `/dashboard/` |

Both workflows are managed by Replit and restart on file changes.

To start manually:
```bash
# API server
pnpm --filter @workspace/api-server run dev

# Dashboard
pnpm --filter @workspace/dashboard run dev
```

## Stack

- **Backend**: Express 5, TypeScript, pnpm monorepo
- **Frontend**: React + Vite + Tailwind (shadcn/ui)
- **Database**: CockroachDB Serverless (SQL + VECTOR index + CDC changefeed)
- **AI**: Anthropic Claude (direct API key) — Bedrock optional
- **Tools**: MCP server (stdio subprocess) with ECS/RDS/Lambda repair tools

## Required secrets (set in Replit Secrets panel)

| Secret | Purpose |
|---|---|
| `COCKROACHDB_URL` | CockroachDB connection string |
| `ANTHROPIC_API_KEY` | Claude API key for the agent loop |
| `COCKROACH_CLOUD_API_KEY` | CockroachDB Cloud REST API (live cluster tools) |
| `COCKROACH_CLOUD_CLUSTER_ID` | Cluster UUID from Cloud Console |
| `VOYAGE_API_KEY` | Semantic embeddings (falls back to hash if absent) |
| `SESSION_SECRET` | Cookie signing secret |

Shared env vars (non-secret, set in `.replit` `[userenv.shared]`):
- `CLOUD_SURGEON_API_KEY` — API auth key between dashboard and API server
- `AI_PROVIDER` — `anthropic` (default) or `bedrock`
- `AWS_REGION` — `us-east-1`
- `BEDROCK_REGION` — `eu-west-1`

## Database schema

Apply once (idempotent):
```bash
psql "$COCKROACHDB_URL&sslrootcert=system" -f cloud-surgeon-agent/database/schema.sql
```

> **Do not use `drizzle-kit push`** — CockroachDB Serverless requires `sslrootcert=system` and uses non-standard VECTOR syntax. Use raw SQL DDL only.

## Trigger a test incident

```bash
curl -X POST https://$REPLIT_DEV_DOMAIN/api/incidents/trigger \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $CLOUD_SURGEON_API_KEY" \
  -d '{"alertText": "ECS checkout-service CPU 92% — task count 2/5"}'
```

## User preferences

- Keep existing project structure — do not restructure or migrate the monorepo layout.
- AWS tools run in SIMULATED mode by default (no `AWS_ACCESS_KEY_ID` set); this is intentional for demo safety.

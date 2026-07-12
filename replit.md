# Cloud-Surgeon

Autonomous AI DevOps agent for the CockroachDB × AWS 2026 Hackathon. Detects infrastructure alerts, diagnoses via RAG vector search (CockroachDB Vector Search), and repairs via an agent loop with tool-calling. All incident state lives in CockroachDB — the agent can crash at any point and resume exactly where it left off.

## Run & Operate

Two services must both be running:

| Workflow | Command | Port |
|---|---|---|
| **Cloud-Surgeon Dashboard** | `streamlit run frontend/app.py --server.port 5000` | 5000 (Streamlit UI) |
| **artifacts/api-server: API Server** | `pnpm --filter @workspace/api-server run dev` | 8080 → proxied to `/api` |

- `pnpm install` — install Node dependencies (run from workspace root)
- `pip install -r cloud-surgeon-agent/requirements.txt` — install Python/Streamlit dependencies
- `psql "$COCKROACHDB_URL&sslrootcert=system" -f cloud-surgeon-agent/database/schema.sql` — apply/re-apply DB schema (idempotent, uses IF NOT EXISTS)
- `pnpm run typecheck` — full TypeScript typecheck
- `pnpm run build` — build all packages

## Required Secrets

| Secret | Description |
|---|---|
| `COCKROACHDB_URL` | CockroachDB Serverless connection string (`postgresql://...?sslmode=verify-full`) |
| `CLOUD_SURGEON_API_KEY` | Shared auth key between Streamlit dashboard and API server |
| `COCKROACH_CLOUD_API_KEY` | (Optional) CockroachDB Cloud API key for real cluster status queries |
| `COCKROACH_CLOUD_CLUSTER_ID` | (Optional) Cluster ID paired with the above |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | (Optional) Enable real Bedrock calls — geo-blocked in Replit's datacenter, falls back to simulated reasoning |

## Stack

- **Frontend**: Streamlit (`cloud-surgeon-agent/frontend/app.py`) — sends HTTP to the API, never touches the DB directly
- **API / Agent engine**: Express 5 + TypeScript (`artifacts/api-server/src/`) — implements the agent loop, MCP tool server, RAG search
- **Database**: CockroachDB Serverless — `incident_state`, `incident_vectors` (native vector index), `execution_logs`
- **ORM**: Drizzle (query builder only; schema applied via raw SQL, not `drizzle-kit push` — see Gotchas)
- **Build**: esbuild (CJS bundle via `build.mjs`)
- **pnpm workspaces**, Node.js 24, TypeScript 5.9

## Where things live

- `cloud-surgeon-agent/` — Python frontend + original AWS Lambda backend + DB schema
- `artifacts/api-server/src/lib/cloud-surgeon.ts` — agent loop (Replit stand-in for Lambda)
- `artifacts/api-server/src/lib/bedrock.ts` — Bedrock client (real call when AWS creds present, simulated otherwise)
- `artifacts/api-server/src/mcp/server.ts` — MCP tool server (stdio)
- `artifacts/api-server/src/mcp/client.ts` — MCP client called by the agent
- `artifacts/api-server/src/middleware/apiKeyAuth.ts` — `x-api-key` enforcement
- `lib/db/src/schema/` — Drizzle schema definitions
- `cloud-surgeon-agent/database/schema.sql` — canonical CockroachDB DDL (source of truth)

## Architecture decisions

- **State in DB, never in memory**: every agent turn writes to `incident_state` before proceeding; a crash at any point leaves a resumable checkpoint.
- **Deduplication by fingerprint**: `alert_fingerprint` (SHA-256 of normalized alert text) prevents duplicate incidents from the same alert.
- **Simulated vs. real**: `thoughtSource: "bedrock" | "simulated"` is always reported honestly — no simulated call is presented as real Bedrock.
- **MCP for tools**: `execute_ccloud_command` and `aws_repair_service` are exposed as a real MCP server (stdio), not hardcoded functions.
- **AWS repair is always simulated**: deliberately — an LLM triggering real destructive actions without a human approval gate is an excluded risk.

## Gotchas

- **Use `psql` + `schema.sql` for DDL, not `drizzle-kit push`**: CockroachDB's dialect (especially `CREATE VECTOR INDEX`) is not guaranteed compatible with drizzle-kit introspection.
- **psql connection string needs `&sslrootcert=system`**: append this to `COCKROACHDB_URL` when using psql directly.
- **Bedrock is geo-blocked**: AWS/Anthropic blocks Bedrock calls from Replit's datacenter. The agent falls back to deterministic simulated reasoning automatically.
- **API server proxied at `/api`**: the Streamlit dashboard calls `http://localhost:80/api` — the proxy routes this to the API server's port.

## User preferences

_Populate as you build._

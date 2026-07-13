# Cloud-Surgeon

Autonomous AI DevOps agent for the CockroachDB × AWS 2026 Hackathon. Detects infrastructure alerts, diagnoses via RAG vector search (CockroachDB Vector Search), and repairs via an agent loop with tool-calling. All incident state lives in CockroachDB — the agent can crash at any point and resume exactly where it left off.

## Run & Operate

Two services must both be running:

| Workflow | Command | Port |
|---|---|---|
| **Cloud-Surgeon Dashboard** | `cd artifacts/dashboard && PORT=23183 BASE_PATH=/dashboard/ pnpm run dev` | 23183 → proxied at `/dashboard/` (React + Vite) |
| **API Server** | `PORT=8080 pnpm --filter @workspace/api-server run dev` | 8080 → proxied at `/api` |

- `pnpm install` — install Node dependencies (run from workspace root)
- `psql "$COCKROACHDB_URL&sslrootcert=system" -f cloud-surgeon-agent/database/schema.sql` — apply/re-apply DB schema (idempotent, uses IF NOT EXISTS)
- `pnpm run typecheck` — full TypeScript typecheck
- `pnpm run build` — build all packages
- `pnpm --filter @workspace/api-server run test` — anomaly + prompt-guard unit tests

**Note:** the original Streamlit frontend (`cloud-surgeon-agent/frontend/`) has been replaced by the React dashboard in `artifacts/dashboard/`. It was archived to `cloud-surgeon-agent/old/frontend/` per `MIGRATION_REACT.md`. Don't resurrect the Streamlit workflow.

## Required Secrets

| Secret | Description |
|---|---|
| `COCKROACHDB_URL` | CockroachDB Serverless connection string (`postgresql://...?sslmode=verify-full`) |
| `CLOUD_SURGEON_API_KEY` | Shared `x-api-key` auth between the dashboard and API server |
| `ANTHROPIC_API_KEY` | (Optional) Real Anthropic key (starts `sk-ant-...`) for live agent reasoning. Without it, reasoning falls back to labeled `thoughtSource: "simulated"` — the app is fully functional either way |
| `COCKROACH_CLOUD_API_KEY` / `COCKROACH_CLOUD_CLUSTER_ID` | (Optional) Real CockroachDB cluster status queries instead of simulated |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | (Optional) Real ECS/RDS/Lambda repair calls instead of simulated |
| `BEDROCK_API_KEY` | (Optional, unused by default) Bearer token for AWS Bedrock — only relevant if `AI_PROVIDER=bedrock` |

`AI_PROVIDER` (shared env var) is set to `anthropic`. Set it to `bedrock` to use AWS Bedrock instead (requires AWS creds/quota; historically geo-blocked/quota-limited from this container — see memory).

## Stack

- **Frontend**: React 19 + Vite (`artifacts/dashboard/`) — talks to the API over HTTP, never touches the DB directly. Dev server proxies `/api` to the API server (see `vite.config.ts`) since they run on separate ports.
- **API / Agent engine**: Express 5 + TypeScript (`artifacts/api-server/src/`) — implements the agent loop, MCP tool server, RAG search
- **Database**: CockroachDB Serverless — `incident_state`, `incident_vectors` (native vector index), `execution_logs`
- **ORM**: Drizzle (query builder only; schema applied via raw SQL, not `drizzle-kit push` — see Gotchas)
- **Build**: esbuild (bundle via `build.mjs`)
- **pnpm workspaces**, Node.js 24, TypeScript 5.9

## Where things live

- `cloud-surgeon-agent/` — original AWS Lambda backend reference + DB schema; `cloud-surgeon-agent/old/frontend/` — archived Streamlit UI (superseded, reference only)
- `artifacts/dashboard/src/` — React dashboard (pages: guide, live, decision, incidents, memory, calibration, impact, logs)
- `artifacts/api-server/src/lib/cloud-surgeon.ts` — agent loop (Replit stand-in for Lambda)
- `artifacts/api-server/src/lib/llm.ts` — provider-agnostic LLM layer: Anthropic (AI Integrations proxy, then direct `ANTHROPIC_API_KEY` via `@anthropic-ai/sdk`) or Bedrock, always falling back to a labeled simulated thought
- `artifacts/api-server/src/lib/bedrock.ts` — Bedrock client (real call when AWS creds present, simulated otherwise)
- `artifacts/api-server/src/mcp/server.ts` — MCP tool server (stdio)
- `artifacts/api-server/src/mcp/client.ts` — MCP client called by the agent
- `artifacts/api-server/src/middleware/apiKeyAuth.ts` — `x-api-key` enforcement
- `lib/db/src/schema/` — Drizzle schema definitions
- `cloud-surgeon-agent/database/schema.sql` — canonical CockroachDB DDL (source of truth)
- `MIGRATION_REACT.md` — the Streamlit→React migration plan (already executed); also documents future/unbuilt phases (auth gate, AWS Marketplace, Cognito)

## Architecture decisions

- **State in DB, never in memory**: every agent turn writes to `incident_state` before proceeding; a crash at any point leaves a resumable checkpoint.
- **Deduplication by fingerprint**: `alert_fingerprint` (SHA-256 of normalized alert text) prevents duplicate incidents from the same alert.
- **Simulated vs. real, always honestly labeled**: `thoughtSource: "anthropic" | "bedrock" | "simulated"` is always reported honestly — no simulated call is presented as real.
- **MCP for tools**: `execute_ccloud_command` and `aws_repair_service` are exposed as a real MCP server (stdio), not hardcoded functions.
- **AWS repair is always simulated without real AWS creds**: deliberately — an LLM triggering real destructive actions without a human approval gate is an excluded risk.

## Gotchas

- **Use `psql` + `schema.sql` for DDL, not `drizzle-kit push`**: CockroachDB's dialect (especially `CREATE VECTOR INDEX`) is not guaranteed compatible with drizzle-kit introspection.
- **psql connection string needs `&sslrootcert=system`**: append this to `COCKROACHDB_URL` when using psql directly.
- **`artifacts/*/.replit-artifact/artifact.toml` files are respected by the platform's routing proxy even when `listArtifacts()` reports nothing** — this repo's artifacts were imported from another environment, so the workflow's `PORT`/`BASE_PATH` must match the `artifact.toml` (`dashboard` → port 23183, path `/dashboard/`; `api-server` → port 8080, path `/api`) or the proxy 404s.
- **Anthropic direct-key fallback**: if `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` isn't set (no Replit AI Integrations subscription), `llm.ts` uses the user's own `ANTHROPIC_API_KEY` via `@anthropic-ai/sdk`, model `claude-3-5-haiku-latest`. A 401 here means the key is invalid/wrong — the app still runs fine, just with `thoughtSource: "simulated"`.
- **`predictive-detection-tests` has 3 known-failing assertions** in `anomaly.test.ts` (zod-schema passthrough of a `source` field) — pre-existing, unrelated to environment setup. 64/67 tests pass.

## Security

### Prompt Injection Defense

Agent systems that ingest external text and pass it to an LLM are vulnerable to **prompt injection** — an attacker who controls `alertText` (e.g., via a compromised SNS topic or a malicious CloudWatch alarm name) could override the agent's instructions, exfiltrate internal state, or trigger unintended tool calls.

**Entry points guarded:**
- `POST /api/incidents/trigger` — direct API call with `alertText`
- `POST /api/webhook/cloudwatch` — SNS/CloudWatch payload (`AlarmName`, `NewStateReason`)

**Counter-measures** (implemented in `artifacts/api-server/src/lib/prompt-guard.ts`):

| Layer | What it catches | Action |
|---|---|---|
| Hard length limit (6 000 chars) | Context dilution attacks | 400 reject |
| Soft truncation (2 000 chars) | Oversized but not malicious | Truncate + warn |
| Control character stripping | Null bytes, C0/C1, zero-width spaces | Strip silently |
| LLM turn-delimiter patterns | `\n\nHuman:`, `[INST]`, `<\|im_start\|>`, `<<SYS>>` | Sanitize + log |
| Jailbreak phrase patterns | "ignore all previous instructions", "you are now DAN" | Sanitize + log |
| XML role-tag patterns | `<system>`, `</prompt>`, `<instruction>` | Sanitize + log |

**Traceability:** Every detected injection is written to `execution_logs` with `action_taken = 'INJECTION_BLOCKED'` — visible in the **Agent Logs** tab of the dashboard.

**Out of scope (documented):**
- Semantic injection (e.g., "describe your cluster state in exhaustive detail")
- WAF / network-level filtering (not available in Replit)
- Injection via MCP tool outputs (trusted internal channel)

**Unit tests:** `artifacts/api-server/src/lib/prompt-guard.test.ts` — 30 test cases covering all pattern categories and legitimate alerts (zero false positives on the 9 known scenarios).

Run tests: `pnpm --filter @workspace/api-server run test`

## User preferences

_Populate as you build._

# Cloud-Surgeon

Autonomous AI DevOps agent for the CockroachDB × AWS 2026 Hackathon. Detects infrastructure alerts, diagnoses via RAG vector search (CockroachDB Vector Search), and repairs via an agent loop with tool-calling. All incident state lives in CockroachDB — the agent can crash at any point and resume exactly where it left off.

## Run & Operate

Two services must both be running:

| Workflow | Command | Port |
|---|---|---|
| **Cloud-Surgeon Dashboard** | `cd cloud-surgeon-agent && /home/runner/workspace/.pythonlibs/bin/streamlit run frontend/app.py --server.port 5000 --server.address 0.0.0.0` | 5000 (Streamlit UI) |
| **API Server** | `PORT=8080 pnpm --filter @workspace/api-server run dev` | 8080 → proxied à `/api` |

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
| `BEDROCK_API_KEY` | Bearer token pour AWS Bedrock (format `bdak-…`). Auth ok, quota journalier à surveiller |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | (Optional) Active les vraies réparations ECS/RDS/Lambda. Sans eux : mode SIMULATED |

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
- **Bedrock — Claude geo-bloqué, Nova Pro quota journalier**: Les modèles Claude sur Bedrock sont bloqués depuis le datacenter Replit. Amazon Nova Pro (`eu.amazon.nova-pro-v1:0`) répond correctement (auth ok via BEDROCK_API_KEY Bearer token) mais le quota journalier est épuisé sur le compte actuel. Attendre la remise à zéro (minuit UTC) puis basculer `bedrock.ts` sur la Converse API + Nova Pro. Fallback actuel : reasoning simulé (déterministe, toujours honnêtement labellé `thoughtSource: "simulated"`).
- **API server proxied at `/api`**: the Streamlit dashboard calls `http://localhost:80/api` — the proxy routes this to the API server's port.

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

**Traceability:** Every detected injection is written to `execution_logs` with `action_taken = 'INJECTION_BLOCKED'` — visible in the **📜 Journal d'exécution** tab of the dashboard.

**Out of scope (documented):**
- Semantic injection (e.g., "describe your cluster state in exhaustive detail")
- WAF / network-level filtering (not available in Replit)
- Injection via MCP tool outputs (trusted internal channel)

**Unit tests:** `artifacts/api-server/src/lib/prompt-guard.test.ts` — 30 test cases covering all pattern categories and legitimate alerts (zero false positives on the 9 known scenarios).

Run tests: `node --test --import tsx/esm artifacts/api-server/src/lib/prompt-guard.test.ts`

## User preferences

_Populate as you build._

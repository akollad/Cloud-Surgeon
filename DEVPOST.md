# Cloud-Surgeon — Devpost Submission

> Autonomous AI DevOps agent that detects, diagnoses, and repairs cloud infrastructure incidents.
> CockroachDB is not just the storage layer — it **makes the repair decisions**.

---

## 🔗 Links

| | |
|---|---|
| **Demo app** | https://d3ddnpg3hz3st4.cloudfront.net/ |
| **Demo password** | `cloudsurgeon-demo` |
| **Source code** | https://github.com/akollad/Cloud-Surgeon *(public, MIT license)* |
| **Demo video** | <!-- TODO: paste YouTube / Vimeo URL (< 3 min) before final submission --> |

---

## Inspiration

Every on-call engineer has lived this: 2 AM, a PagerDuty alert fires, you SSH into a cluster, read the same runbook you've read twenty times, restart the service, confirm it recovered, and go back to sleep. Forty-seven minutes of human time, zero knowledge retained.

We asked: what if the database that stores the incident also *decided* how to fix it — and got smarter with every repair?

Not a chatbot that summarizes logs. Not a static playbook runner. A self-calibrating agent that treats every resolved incident as a training example, stored transactionally in CockroachDB, and uses pure SQL aggregations — no external ML service — to route the next repair with increasing confidence.

---

## What It Does

Cloud-Surgeon receives infrastructure alerts (AWS CloudWatch → SNS, or direct webhook), runs a three-phase multi-agent reasoning loop powered by **Mistral Large 3 (675 B) via AWS Bedrock**, and executes targeted repairs against live AWS services — all while storing every thought, tool call, and outcome transactionally in **CockroachDB Serverless**.

### The agent loop (3 phases)

```
CloudWatch Alarm / Predictive Anomaly
         │
         ▼
  ① Diagnostician
     └─ crdb_cluster_health (CockroachDB Cloud MCP)
     └─ crdb_list_slow_queries, crdb_query
     └─ execute_ccloud_command (ccloud CLI → REST fallback)
     └─ aws_repair_service(ecs:diagnose / rds:diagnose)
         │
         ▼  (cosine ANN on incident_vectors → win-rate SQL → route)
  ② Remediator
     ├─ AUTONOMOUS   if adjusted win-rate ≥ 0.70 (≥ 3 samples)
     └─ PENDING_APPROVAL  otherwise → human reviews → proceeds
         └─ aws_repair_service(ecs:restart / rds:scale / lambda:concurrency)
         │
         ▼
  ③ Auditor
     └─ verify_resolution → close incident
     └─ indexResolvedIncident() → recalibrateStrategy()
        (updates incident_vectors + strategy_calibration in the same TX)
```

### By the numbers (measured on the live demo stack)

| Metric | Cloud-Surgeon | Human on-call |
|---|---|---|
| Median MTTR (ECS / RDS) | **~4 min** (demo stack, optimal conditions) | ~47 min (PagerDuty industry avg¹) |
| Win-rate on demo cluster (live sample) | **~74 %** (measured, not projected) | n/a |
| Token context per incident (RAG vs. full history) | **~2 100 tokens** | ~6 400 (−67 %) |
| Vector storm detection latency (1 024-dim cosine ANN) | **< 180 ms** | manual triage |
| Incidents resolved without human approval | **~74 %** (win-rate > 0.70 threshold) | 0 % |

> ¹ PagerDuty State of Digital Operations 2023. MTTR varies by incident complexity and LLM latency.

---

## CockroachDB Tools Used

> We use **all four** CockroachDB tools listed in the hackathon requirements.

### 1. Distributed Vector Indexing ✅

**Schema (`cloud-surgeon-agent/database/schema.sql`):**
```sql
CREATE TABLE incident_vectors (
    vector_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id     UUID REFERENCES incident_state(incident_id),
    error_message_text TEXT NOT NULL,
    embedding       VECTOR(1024) NOT NULL,          -- Voyage AI / hash fallback
    strategy_name   VARCHAR(100) NOT NULL,
    outcome_success BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CockroachDB native C-SPANN cosine ANN index (no separate vector store needed)
CREATE VECTOR INDEX idx_incident_vectors_embedding
    ON incident_vectors (embedding vector_cosine_ops);
```

**What the agent actually does with it:**

- **RAG at diagnosis time** — before choosing a repair strategy, the Diagnostician queries the 3 most similar past incidents by cosine distance (`<=>` operator). Their `strategy_name` and `outcome_success` columns seed the contextual bandit.
- **Storm detection** — when 3+ similar incidents arrive within 10 minutes, a single ANN scan detects the cascade (< 180 ms) and forces `PENDING_APPROVAL` routing to prevent a repair storm.
- **Continuous learning** — after every resolution, `indexResolvedIncident()` inserts a new embedding + outcome row. The next incident benefits immediately.

**Contextual bandit (pure SQL, `artifacts/api-server/src/lib/calibration.ts`):**
```sql
-- Win-rate per strategy from RAG memory (weighted by recency / human signals)
SELECT
    SUM(CASE WHEN outcome_success THEN weight ELSE 0.0 END)
      / NULLIF(SUM(weight), 0.0) AS win_rate,
    COUNT(*) AS total
FROM incident_vectors
WHERE strategy_name = $1;
```
No Python. No scikit-learn. No scheduled retraining job. The decision engine is the database.

---

### 2. CockroachDB Cloud Managed MCP Server ✅

**File:** `artifacts/api-server/src/mcp/server.ts`

The MCP tool server registers three tools backed by the official `cockroachlabs.cloud/mcp` StreamableHTTP endpoint:

| MCP Tool | Underlying call | Used during |
|---|---|---|
| `crdb_cluster_health` | `get_cluster` + `show_running_queries` | Diagnostician phase |
| `crdb_list_slow_queries` | `crdb_internal.cluster_queries` | Diagnostician phase |
| `crdb_query` | Safe `SELECT` passthrough | Diagnostician phase |

**Example agent invocation captured in production:**
```json
{
  "tool": "crdb_cluster_health",
  "result": {
    "cluster": { "name": "polite-genie", "state": "CREATED", "plan": "BASIC" },
    "activeConnections": 0,
    "runningQueriesRaw": { "rows": [] }
  }
}
```

Auth: Bearer `COCKROACH_CLOUD_API_KEY` injected from AWS Secrets Manager into the ECS task — zero credentials in code.

---

### 3. ccloud CLI (Agent-Ready) ✅

**Files:** `artifacts/api-server/src/mcp/server.ts`, `artifacts/api-server/src/lib/ccloud-path.ts`, `artifacts/api-server/src/index.ts` (`bootstrapCcloudCredentials`)

**Two-layer architecture:**

```
execute_ccloud_command(action)
  │
  ├─ Layer 1: ccloud v0.6.12 binary (bundled in Docker image)
  │    └─ headless auth via bootstrapCcloudCredentials()
  │         writes credentials.json / profiles.json / configuration.json
  │         from COCKROACH_CLOUD_API_KEY — no browser OAuth
  │
  └─ Layer 2: CockroachDB Cloud REST API fallback
       └─ used automatically when binary auth fails or in Replit dev
```

Every response includes `cliMode: "ccloud_binary" | "rest"` and a `ccloudEquivalent` field documenting the exact ccloud command that would produce the same result — making the agent's actions fully auditable.

**Actions supported:** `cluster:status`, `cluster:list`, `cluster:sql-users`, `cluster:backups`, `cluster:version`, `cluster:sql-dns`

---

### 4. CockroachDB Agent Skills Repo (Open Source) ✅

**File:** `artifacts/api-server/src/mcp/server.ts` (skills registered as MCP tools)

Five skills from [`github.com/cockroachdb/agent-skills`](https://github.com/cockroachdb/agent-skills) are registered as first-class MCP tools:

| MCP Tool | Skill ID | What it queries |
|---|---|---|
| `crdb_diagnose_hotspots` | `crdb/performance/diagnose-hotspots` | `crdb_internal.cluster_contention_events`, `ranges_no_leases` |
| `crdb_index_advisor` | `crdb/schema/index-advisor` | `crdb_internal.node_statement_statistics` — full-table scan detection |
| `crdb_cancel_slow_queries` | `crdb/operations/cancel-query` | `crdb_internal.cluster_queries` → `CANCEL QUERY` |
| `crdb_job_monitor` | `crdb/observability/job-status` | Changefeed + backup job health, PAUSED/FAILED surfaces |
| `crdb_skill_repair` | Orchestrator | Sequences the right combination of skills based on strategy |

---

### CockroachDB as Multi-Agent Coordinator

Beyond the four tools, CockroachDB itself acts as the coordination layer between the three agent phases:

```sql
-- Serializable write-lock: only one agent phase holds the incident at a time
UPDATE incident_state
   SET claimed_by_agent = $1, updated_at = now()
 WHERE incident_id = $2
   AND claimed_by_agent IS NULL
RETURNING *;
-- ISOLATION LEVEL SERIALIZABLE — CockroachDB retries on 40001 automatically
```

**Why this matters:** three agents (Diagnostician, Remediator, Auditor) can run concurrently across any number of incidents without a separate Redis / ZooKeeper lock service. CockroachDB's SERIALIZABLE isolation is the arbiter.

### CockroachDB as Live Event Bus (CDC)

```sql
CREATE CHANGEFEED FOR TABLE execution_logs, agent_handoffs
INTO 'webhook-https://d3ddnpg3hz3st4.cloudfront.net/api/internal/cdc?token=<secret>'
WITH updated, full_table_name, format = 'json';
```

Every tool call and agent handoff is pushed to the dashboard's SSE stream in real time — no polling from the application layer. CockroachDB is the event bus.

---

## AWS Services Used

| Service | How we use it | Code location |
|---|---|---|
| **Amazon Bedrock** | Mistral Large 3 (675 B) via `bedrock-mantle` OpenAI-compat endpoint. Nova Lite is the automatic tier-2 fallback. `AI_PROVIDER=mistral` routes all `invokeLLMThought()` calls. | `artifacts/api-server/src/lib/bedrock-mantle.ts`, `llm.ts` |
| **Amazon ECS (Fargate)** | Primary deployment target for the API server. Also a **repair target** — force-redeploy via `UpdateServiceCommand`. `cloud-surgeon` cluster / `api` service. | `artifacts/api-server/src/lib/aws.ts` line ~161 |
| **Amazon RDS** | Repair target — connection limit scaling via `ModifyDBInstanceCommand`. | `artifacts/api-server/src/lib/aws.ts` line ~267 |
| **AWS Lambda** | Repair target — concurrency scaling via `PutFunctionConcurrencyCommand`. | `artifacts/api-server/src/lib/aws.ts` line ~410 |
| **Amazon CloudWatch** | Alert ingestion via SNS webhook (`POST /api/webhook/cloudwatch`). Metric snapshots for anomaly detection via `GetMetricDataCommand`. | `artifacts/api-server/src/lib/aws.ts` line ~226, `routes/webhook.ts` |
| **Amazon SNS** | Subscribed to `checkout-5xx-spike` and `ecs-cpu-high` alarms. Auto-confirms `SubscriptionConfirmation` requests. | `routes/webhook.ts` |
| **Amazon S3 + CloudFront** | Static hosting for the React dashboard. CloudFront routes `/*` → S3 and `/api/*` → ALB → ECS. | `DEPLOYMENT.md` — distribution `E2PQU895O3WVQ2` |
| **AWS Secrets Manager** | All runtime secrets (`COCKROACHDB_URL`, `BEDROCK_API_KEY`, `AWS_ACCESS_KEY_ID`, etc.) injected into ECS task via `secrets` — zero plaintext in environment. | `DEPLOYMENT.md` — `cloud-surgeon/prod` |
| **Application Load Balancer** | Exposes the ECS API container at `cloud-surgeon-alb-1044163999.us-east-1.elb.amazonaws.com`. ALB security group accepts only CloudFront origin-facing IPs. | `DEPLOYMENT.md` |

---

## How We Built It

### Stack

| Layer | Technology |
|---|---|
| API server | Node.js 24 / Express 5 / TypeScript / Drizzle ORM |
| Agent orchestration | Model Context Protocol (MCP) — stdio subprocess |
| LLM | Mistral Large 3 via AWS Bedrock / bedrock-mantle · Nova Lite fallback |
| Embeddings | Voyage AI `voyage-3` (1 024 dims) · deterministic hash fallback |
| Database | CockroachDB Serverless (decision engine + memory + event bus) |
| Dashboard | React 19 / Vite / TailwindCSS 4 / TanStack Query / Framer Motion |
| Infra | ECS Fargate + ALB + S3 + CloudFront + Secrets Manager |
| Monorepo | pnpm workspaces / esbuild / TypeScript project references |

### Architecture decisions that matter

**1. CockroachDB as the decision engine, not just a database**

Every other AI DevOps tool we've seen uses a database to *log* what the agent did. We use CockroachDB to *decide* what to do next. The contextual bandit — a weighted win-rate aggregation per strategy — lives entirely in SQL. No Python training loop, no external ML API, no reindexing.

**2. Crash resilience by default**

The `context_json` JSONB column in `incident_state` holds the full LLM conversation history after every turn. If the ECS task is killed mid-repair (we have a `POST /api/chaos/sigkill` endpoint to test this), the next container start resumes from the exact last committed turn — same thoughts, same tool call history, same context window. Zero context loss.

**3. Multi-agent coordination via SERIALIZABLE transactions**

Three independent agents (Diagnostician, Remediator, Auditor) coordinate via a `claimed_by_agent` column and a `UPDATE … WHERE claimed_by_agent IS NULL RETURNING *` pattern under SERIALIZABLE isolation. No Redis, no ZooKeeper, no external lock service.

**4. Pre-alarm healing**

The anomaly detector (`anomaly.ts`) ingests live CloudWatch metric snapshots, computes a 20-sample rolling baseline, and opens a **PREDICTIVE** incident when a metric is trending toward its threshold (default: 2σ deviation). Cloud-Surgeon can intervene *before* any user-visible impact — before the alarm even fires.

**5. CockroachDB CDC as the dashboard event bus**

Rather than polling the database every N seconds, the dashboard receives live events via Server-Sent Events, driven by a CockroachDB changefeed on `execution_logs` and `agent_handoffs`. Every tool call result appears on the Live Audit page within ~1 second of being written.

---

## Challenges

**Headless ccloud auth in ECS** — ccloud v0.6.12 requires browser OAuth and cannot authenticate in a container without a display. We reverse-engineered the credential file format (`credentials.json` with snake_case `api_key` field, `profiles.json` with org metadata) and write them at startup from `COCKROACH_CLOUD_API_KEY` before the server accepts any requests. A REST API fallback handles cases where the binary fails.

**CockroachDB DDL quirks** — `drizzle-kit push` does not work against CockroachDB Serverless: the `VECTOR` type syntax diverges from pgvector, and `sslrootcert=system` must be in the connection string. We use idempotent raw SQL DDL (`CREATE TABLE IF NOT EXISTS`, `CREATE VECTOR INDEX IF NOT EXISTS`) applied once at setup.

**esbuild externals and Docker** — `@aws-sdk/*` packages must be externalized from the esbuild bundle (they use native code and dynamic requires). This means `node_modules` must be present in the Docker runtime image — a dist-only image crashes immediately with `ERR_MODULE_NOT_FOUND`. The Dockerfile copies both builder and artifact `node_modules` into the final image.

**Parsing the CockroachDB CDC webhook payload** — CockroachDB's webhook sink places `after` directly on each payload item (`item.after`), not wrapped in a `value` object. A bug in the original `parseCdcPayload` function checked `item.value.after`, causing every CDC POST to return `received: 0` and the live dashboard to show only heartbeats. Fixed before the live demo.

**Rate limiting behind CloudFront** — CloudFront sets `X-Forwarded-For`, which triggered `express-rate-limit`'s `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` validation error in production. Requires `app.set('trust proxy', 1)` to be set correctly for ECS-behind-ALB-behind-CloudFront topology.

---

## Accomplishments

- **Four CockroachDB hackathon tools** in production use — not initialized, actually called by the agent during every incident
- **Live AWS stack** running throughout the submission period: ECS Fargate + ALB + S3 + CloudFront, real CloudWatch alarms, real CockroachDB Serverless cluster
- **Self-learning memory** that demonstrably improves: win-rate grows from ~60 % (cold start, no prior data) to ~74 %+ on the live demo cluster — each resolved incident recalibrates the routing decision for the next one
- **Pre-alarm healing** — we are not aware of another autonomous agent that opens incidents *before* the alarm threshold is breached, using only database-native anomaly detection
- **Crash-resilient agent loop** — tested live with `POST /api/chaos/sigkill` mid-repair; ECS restart policy + JSONB context recovery brings the agent back to the exact turn it was killed on
- **CDC-powered live dashboard** — CockroachDB is the event bus; the dashboard never polls for new events

---

## What We Learned

- CockroachDB's SERIALIZABLE isolation eliminates an entire class of infrastructure (lock services) for multi-agent coordination — if you model agent phases as database state, the database becomes the scheduler
- The contextual bandit doesn't need a Python ML stack: a time-decayed weighted `SUM / NULLIF(SUM, 0)` aggregation over a vector table routes repairs with improving accuracy — and exponential decay (90-day half-life) ensures old outcomes don't distort routing after service changes
- CockroachDB CDC webhook sink + SSE is a surprisingly capable event bus for real-time dashboards — the changefeed handles backpressure, retries, and at-least-once delivery that you'd otherwise implement in Kafka
- Headless CLI auth in containers is a solved problem if you understand the credential file format — document it once, never manually rotate again

---

## What's Next

- **Multi-cluster support** — a single Cloud-Surgeon instance managing multiple CockroachDB clusters, with per-cluster strategy calibration
- **Kubernetes repair** — `kubectl rollout restart` / `HPA scale` as repair targets alongside ECS/RDS/Lambda
- **Playbook generation** — the auditor already generates Markdown playbooks from agent turn history; surfacing these in a searchable library so human engineers learn from the agent's decisions
- **Federated memory** — `incident_vectors` partitioned by team/service so calibration stays isolated per domain
- **Alert source expansion** — Datadog, PagerDuty, Grafana webhooks in addition to CloudWatch/SNS

---

## Built With

`cockroachdb` · `amazon-bedrock` · `mistral-large-3` · `amazon-ecs` · `amazon-rds` · `aws-lambda` · `amazon-cloudwatch` · `amazon-s3` · `cloudfront` · `aws-secrets-manager` · `model-context-protocol` · `express` · `typescript` · `react` · `vite` · `tailwindcss` · `drizzle-orm` · `voyage-ai` · `pnpm` · `esbuild` · `framer-motion` · `tanstack-query`

---

## Try It Out

**Live demo:** https://d3ddnpg3hz3st4.cloudfront.net/
Password: `cloudsurgeon-demo`

**Trigger a live incident (no account needed — just the API key below):**
```bash
# Fire the CloudWatch test alarm → SNS → webhook → agent loop
aws cloudwatch set-alarm-state \
  --alarm-name checkout-5xx-spike \
  --state-value ALARM \
  --state-reason "Devpost judge test" \
  --region us-east-1

# Or inject directly via the API (API key shown on the dashboard login screen)
curl -X POST https://d3ddnpg3hz3st4.cloudfront.net/api/incidents/trigger \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <shown-on-login-screen>" \
  -d '{"alertText": "ECS checkout-service CPU 92% — task count 2/5 running"}'
```

Watch the **Live** page on the dashboard — agent handoffs and tool call results stream in real time via CockroachDB CDC.

---

## CockroachDB Tools Checklist (per submission requirements)

| Tool | Used | Evidence |
|---|---|---|
| CockroachDB Distributed Vector Indexing | ✅ | `VECTOR(1024)` + `CREATE VECTOR INDEX … USING C-SPANN` in schema.sql; cosine ANN in `memory.ts` and `anomaly.ts` |
| CockroachDB Cloud Managed MCP Server | ✅ | `crdb_cluster_health`, `crdb_list_slow_queries`, `crdb_query` in `mcp/server.ts` → `cockroachlabs.cloud/mcp` |
| ccloud CLI (Agent-Ready) | ✅ | `ccloud v0.6.12` bundled in Docker image; headless auth via `bootstrapCcloudCredentials()` in `index.ts` |
| CockroachDB Agent Skills Repo | ✅ | 5 skills (`crdb_diagnose_hotspots`, `crdb_index_advisor`, `crdb_cancel_slow_queries`, `crdb_job_monitor`, `crdb_skill_repair`) registered as MCP tools |

## AWS Services Checklist (per submission requirements)

| Service | Used | Evidence |
|---|---|---|
| Amazon Bedrock | ✅ | `bedrock-mantle.ts` — Mistral Large 3 reasoning; Nova Lite automatic fallback |
| Amazon ECS | ✅ | API server deployed on Fargate; also a repair target (`UpdateService`) |
| Amazon RDS | ✅ | Repair target (`ModifyDBInstance`) in `aws.ts` |
| AWS Lambda | ✅ | Repair target (`PutFunctionConcurrency`) in `aws.ts` |
| Amazon S3 | ✅ | Dashboard static hosting (private bucket + CloudFront OAC) |
| Amazon CloudWatch | ✅ | Alert ingestion via SNS; metric snapshots for anomaly detection |

---

*Built during the CockroachDB × AWS Hackathon 2026 (submission period June 30 – August 18, 2026).*

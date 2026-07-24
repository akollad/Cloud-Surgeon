# Cloud-Surgeon — AWS Deployment Guide

> This document describes the **current** architecture (Express 5 + React SPA, pnpm monorepo)
> and the AWS infrastructure used for the live demo deployment.

---

## ✅ Currently LIVE (AWS account 153983052396, us-east-1)

| Component | URL / ID |
|---|---|
| **Dashboard** | https://d3ddnpg3hz3st4.cloudfront.net/ |
| **API (via CloudFront)** | https://d3ddnpg3hz3st4.cloudfront.net/api/healthz |
| **ALB (API origin)** | cloud-surgeon-alb-1044163999.us-east-1.elb.amazonaws.com |
| **ECS cluster / service** | `cloud-surgeon` / `api` (Fargate, 1 task, task-def revision 6) |
| **ECR** | `153983052396.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api` |
| **S3 dashboard** | `cloud-surgeon-dashboard-153983052396` |
| **CloudFront distribution** | `E2PQU895O3WVQ2` |
| **Secrets Manager** | `cloud-surgeon/prod` |
| **SNS topic** | `arn:aws:sns:us-east-1:153983052396:cloud-surgeon-alerts` (webhook confirmed ✅) |
| **CloudWatch alarms** | `checkout-5xx-spike` · `ecs-cpu-high` (both OK ✅) |

Last verified (July 22 2026): `{"status":"ok"}` — CloudFront health check confirmed post-deploy.
Demo dashboard password: `cloudsurgeon-demo`.

**Task definition revision 15** (current — 2026-07-24): Redeployed with 4 judge-review fixes: (1) chaos route now requires `CHAOS_ENABLED=true` env var + optional `X-Chaos-Key` header — returns 403 without it; (2) temporal decay added to win-rate SQL (90-day exponential half-life via `CALIBRATION_HALF_LIFE_DAYS=90`); (3) new `GET /api/healthz/embedding` endpoint surfaces active embedding provider; (4) README/DEVPOST metrics aligned with code (threshold 0.70, ~74% win-rate). Docker image rebuilt and pushed to ECR (digest sha256:0684d9a…72cd4ec). Dashboard unchanged — S3/CloudFront not touched. ECS force-new-deployment confirmed stable, 1/1 tasks running, `/api/healthz` → `{"status":"ok"}`, `/api/healthz/embedding` → `{"provider":"voyage-3","semantic":true}`.

**Task definition revision 14** (previous — 2026-07-23): Redeployed with two fixes: `calibration.ts` win-rate routing threshold restored to 70% (AUTONOMOUS gate); `chaos.ts` switched from `process.kill()` to `process.exit(1)` so ECS restart policy triggers correctly. Docker image rebuilt and pushed to ECR (digest sha256:d9a0ccb…ee83f0). Dashboard unchanged — S3/CloudFront not touched. ECS force-new-deployment confirmed stable, 1/1 tasks running, `/api/healthz` → `{"status":"ok"}`.

**Task definition revision 14** (previous — 2026-07-22): Redeployed with sound notification system (Web Audio API, no audio files) added to dashboard. Docker image rebuilt and pushed to ECR. Dashboard rebuilt with BASE_PATH=/ and synced to S3 (CloudFront invalidation I4T7UYYJJXOS2XVNSB8U2OER0A). ECS service updated to task-definition/cloud-surgeon-api:14, 1/1 tasks running.

**Task definition revision 14** (previous entry — 2026-07-20) (current — 2026-07-20): Fixed ccloud headless auth in ECS. Root cause: `index.ts` was missing `import path from "node:path"` — esbuild bundled it without the import, `path.join()` threw a `ReferenceError` swallowed by `.catch(() => {})`, no credential files were written, ccloud reported "not logged in" on every boot. Fix: added the import + moved `configHome`/`dir` calculation inside the `try` block. Boot log now shows `🟢 authenticated (logged in to "Akollad Groupe")` on every container start. Also fixed: credentials.json format was `{ "default": { "apiKey": "..." } }` (camelCase) — ccloud v0.6.12 expects `{ "default": { "api_key": "..." } }` (snake_case, `json:"api_key"` tag in Go struct).

**Task definition revision 13** (2026-07-20): Switched AI provider from Anthropic to **Mistral Large 3 (675B) via bedrock-mantle** (`AI_PROVIDER=mistral`). New `BEDROCK_API_KEY` secret injected from Secrets Manager. `src/lib/bedrock-mantle.ts` added — OpenAI-compat Bearer-token client for `https://bedrock-mantle.us-east-1.api.aws/v1`. Nova Lite kept as automatic fallback if mantle fails. IAM fix: added inline policy `cloud-surgeon-secrets-access` to `ecsTaskExecutionRole` granting `secretsmanager:GetSecretValue` on `cloud-surgeon/prod`. CloudFront invalidation: I3QK8WBMK8XG0GBIYFVP2Y29FN. Dashboard rebuilt and re-synced to S3. Boot log confirmed: `[BOOT] AI: mistral — 🟢 LIVE (mistral.mistral-large-3-675b-instruct) | AWS tools: 🟢 LIVE (region: us-east-1) | DB: connected`. Previous (rev 12, 2026-07-19): repair plan now fully LLM-generated; auth fix LoginGate JWT expiry. Rev 11: `ECS_DEFAULT_SERVICE=api`; rev 10: `ECS_DEFAULT_CLUSTER=cloud-surgeon`; rev 6: curl in runtime stage.

**Live AWS repair note**: `src/lib/aws.ts` explicitly requires `AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY` as environment variables to enter LIVE mode — the ECS task role alone
is not enough because the code does not rely on the SDK default credential chain. Both keys are
injected as additional secrets in the task definition alongside the task IAM role.

---

## Architecture overview

```
Internet (HTTPS)
       │
       ▼
┌───────────────────────────┐
│   Amazon CloudFront        │  (CDN + single public entry point)
│   https://<distribution>   │
└──────────┬─────────────────┘
           │
   ┌───────┴────────────────────────────┐
   │                                    │
   ▼                                    ▼
/*  → S3 (React dashboard,      /api/* → ALB → ECS Fargate
    static Vite build)                (Express 5 API Server)
                                             │
                                             │ stdio MCP subprocess
                                             │ (bundled in the same container)
                                             │
                                             ▼
                                   COCKROACHDB_URL (TLS)
                                             │
                                             ▼
                                  CockroachDB Serverless
                                  (cloud.cockroachlabs.com)

                                   HTTPS Bearer (COCKROACH_CLOUD_API_KEY)
                                             │
                                             ▼
                                  cockroachlabs.cloud/mcp
                                  (Managed Cloud MCP — cluster health,
                                   slow queries, SQL diagnostics)

AWS CloudWatch Alarm ──▶ SNS Topic ──▶ POST /api/webhook/cloudwatch (via CloudFront → ALB)
```

---

## Services to deploy

| Service | Technology | Port | Hosting |
|---|---|---|---|
| **API Server** (agent loop + REST + MCP client) | Node.js 24 / Express 5 / TypeScript | 8080 | ECS Fargate |
| **MCP Tool Server** (`aws_repair_service`, `execute_ccloud_command`, `crdb_*`) | Node.js (stdio subprocess) | — | Bundled inside the API Server container — no separate service |
| **Dashboard** | React 19 / Vite (static SPA) | — | S3 + CloudFront |
| **Database / agent memory** | CockroachDB Serverless | 26257 | Cloud (already provisioned) |

There is **no** Python/Streamlit component — the dashboard is a static build
(`pnpm --filter @workspace/dashboard run build` → `artifacts/dashboard/dist/public`)
served directly from S3.

---

## Step 0 — CockroachDB: the two hackathon tools used

The project uses two of the four CockroachDB tools required by the hackathon:

1. **Distributed Vector Indexing** — `incident_vectors.embedding VECTOR(1024)` +
   `CREATE VECTOR INDEX ... USING C-SPANN` in `cloud-surgeon-agent/database/schema.sql`.
   Active as soon as `COCKROACHDB_URL` points to the Serverless cluster.
2. **CockroachDB Cloud Managed MCP Server** — `crdb_cluster_health`, `crdb_list_slow_queries`,
   `crdb_query` in `artifacts/api-server/src/mcp/server.ts` call
   `https://cockroachlabs.cloud/mcp` (StreamableHTTP + Bearer `COCKROACH_CLOUD_API_KEY`).
   These three tools are **inactive without this key** — it must be set before any demo.

**Note on the ccloud CLI**: `ccloud v0.6.12` requires browser-based OAuth and cannot
authenticate headlessly inside a container or CI environment — there is no browser to complete
the login. Cloud-Surgeon calls the same CockroachDB Cloud REST API that ccloud wraps
(`https://cockroachlabs.cloud/api/v1/clusters/...`), authenticated via service-account API key,
producing identical results. Every response includes a `ccloudEquivalent` field documenting the
exact ccloud command that would return the same output. The "at least 2 CockroachDB tools"
criterion is met by the vector index + managed Cloud MCP — not by this REST wrapper.

---

## Step 1 — AWS prerequisites

### 1.1 AWS services to enable
```
- ECR (Elastic Container Registry)     — API Server container image
- ECS Fargate                           — container runtime, no servers to manage
- Application Load Balancer (ALB)       — exposes the API Server behind /api
- S3                                    — private bucket for the static dashboard build
- CloudFront                            — CDN + routing /* → S3, /api/* → ALB, HTTPS termination
- ACM (us-east-1 for CloudFront)        — TLS certificate
- Secrets Manager                       — all secrets (never in plaintext in task defs)
- CloudWatch + SNS                      — real alert source to trigger the agent
- IAM                                   — ECS task role scoped to ECS/RDS/Lambda repair
- VPC                                   — default VPC is fine for a demo
```

### 1.2 IAM — ECS task role (`cloud-surgeon-task-role`)

The task role only needs to cover what `artifacts/api-server/src/lib/aws.ts` actually calls
(ECS/RDS/Lambda repair). **Not** `bedrock:InvokeModel` — this demo uses the Anthropic API
directly (`ANTHROPIC_API_KEY`); Bedrock quota is currently disabled on the demo account.

The policy below uses the minimal, resource-scoped principle of least privilege.
`cloudwatch:GetMetricData` and `cloudwatch:DescribeAlarms` are listed under `"Resource": "*"`
only because AWS does not support resource-level ARNs for those two CloudWatch actions — this
is an AWS API limitation, not a configuration choice.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcsRepair",
      "Effect": "Allow",
      "Action": [
        "ecs:UpdateService",
        "ecs:DescribeServices"
      ],
      "Resource": [
        "arn:aws:ecs:<REGION>:<ACCOUNT_ID>:service/cloud-surgeon/*",
        "arn:aws:ecs:<REGION>:<ACCOUNT_ID>:cluster/cloud-surgeon"
      ]
    },
    {
      "Sid": "RdsRepair",
      "Effect": "Allow",
      "Action": [
        "rds:ModifyDBInstance",
        "rds:DescribeDBInstances",
        "rds:RebootDBInstance"
      ],
      "Resource": "arn:aws:rds:<REGION>:<ACCOUNT_ID>:db:*"
    },
    {
      "Sid": "LambdaRepair",
      "Effect": "Allow",
      "Action": [
        "lambda:PutFunctionConcurrency",
        "lambda:GetFunctionConcurrency"
      ],
      "Resource": "arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:*"
    },
    {
      "Sid": "CloudWatchRead",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudwatch:DescribeAlarms"
      ],
      "Resource": "*"
    }
  ]
}
```

To apply to the actual demo role (account 153983052396, us-east-1):

```bash
# Replace the inline policy on the task role with the scoped version above
aws iam put-role-policy \
  --role-name cloud-surgeon-task-role \
  --policy-name cloud-surgeon-task-policy \
  --policy-document file://iam-task-policy.json \
  --region us-east-1
```

Save the JSON above (with `153983052396` and `us-east-1` substituted) as `iam-task-policy.json`
and run the command once. The new policy takes effect immediately without a task restart.

---

## Step 2 — Docker image (API Server only)

The dashboard no longer needs a Docker image: it is a static artifact pushed to S3.

`Dockerfile.api` at the monorepo root:
```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/
RUN npm install -g pnpm && pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/artifacts/api-server/package.json ./artifacts/api-server/package.json
WORKDIR /app/artifacts/api-server
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
```

`dist/mcp/server.mjs` is included in the same build (esbuild multi-entry) — the MCP tool
server runs as a stdio subprocess of the main process, not a separate service.

**ccloud CLI binary** — the runtime stage downloads the official CockroachDB Cloud CLI:
- It is bundled in the Docker image via a dedicated `debian:bookworm-slim` build stage.
- In ECS, set `COCKROACH_API_KEY` = `<COCKROACH_CLOUD_API_KEY value>` in the task definition
  so the binary authenticates headlessly (no browser OAuth).
- In local dev (no Docker), the binary is not in PATH; `execute_ccloud_command` falls back
  transparently to the CockroachDB Cloud REST API. The `cliMode` field in the response indicates
  which path was used: `"ccloud_binary"` (ECS production) or `"rest"` (local fallback).
- **Do not switch back to `node:24-alpine`** for the runtime stage — the ccloud binary is a
  glibc binary and is incompatible with Alpine's musl libc.

**Important**: `build.mjs` externalises `@aws-sdk/*` (and other native packages) from the
esbuild bundle — `src/lib/aws.ts` and `src/lib/embeddings.ts` import them statically for
ECS/RDS/Lambda/CloudWatch and Bedrock. Without `node_modules` in the final image the container
crashes immediately at startup (`ERR_MODULE_NOT_FOUND`). The Dockerfile above copies
`node_modules` from the builder stage — do not revert to a `dist/`-only image without
re-bundling these packages.

```bash
aws ecr create-repository --repository-name cloud-surgeon-api --region us-east-1

aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

docker build -f Dockerfile.api -t cloud-surgeon-api .
docker tag cloud-surgeon-api:latest \
  <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api:latest
docker push <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api:latest
```

---

## Step 3 — Dashboard: static build + S3

```bash
cd artifacts/dashboard
PORT=23183 BASE_PATH=/ pnpm run build
```

### ⚠️ Safe S3 deploy order — do NOT skip this

Vite generates content-hashed filenames (e.g. `assets/index-C4ib8eU3.css`). Every build
produces new hashes. If you run `aws s3 sync --delete` before CloudFront finishes invalidating
its `index.html` cache, edge nodes still serve the old HTML pointing to the old asset hashes,
but those files are already gone from S3. CloudFront then returns the S3 "not found" fallback
(which is `index.html` — an HTML document), so browsers reject the response with:

```
The stylesheet … was not loaded because its MIME type, "text/html", is not "text/css"
Loading module … was blocked because of a disallowed MIME type ("text/html")
```

**Always follow this order:**

```bash
# 1. Upload NEW assets first — no --delete yet; old files stay alive during the transition
aws s3 sync dist/public/ s3://cloud-surgeon-dashboard-153983052396/ --region us-east-1

# 2. Invalidate CloudFront and WAIT for completion (typically 30–90 s)
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id E2PQU895O3WVQ2 \
  --paths "/*" \
  --query 'Invalidation.Id' --output text)

aws cloudfront wait invalidation-completed \
  --distribution-id E2PQU895O3WVQ2 \
  --id "$INVALIDATION_ID"
echo "Invalidation complete — old HTML is no longer served by any edge node"

# 3. NOW clean up old hashed assets — safe because all edges serve the new index.html
aws s3 sync dist/public/ s3://cloud-surgeon-dashboard-153983052396/ \
  --delete --region us-east-1
```

The bucket stays **private**; CloudFront accesses it via Origin Access Control (OAC), no direct
public bucket access.

> **Why old files don't conflict:** Vite content-hash filenames are unique per build, so keeping
> old files alive during the invalidation window costs a few hundred KB at most and causes zero
> functional issues. The `--delete` pass in step 3 removes them once it's safe.

---

## Step 4 — Secrets (AWS Secrets Manager)

```bash
aws secretsmanager create-secret \
  --name cloud-surgeon/prod \
  --secret-string '{
    "COCKROACHDB_URL": "postgresql://user:pass@host:26257/cloud_surgeon?sslmode=verify-full",
    "CLOUD_SURGEON_API_KEY": "<openssl rand -hex 32>",
    "SESSION_SECRET": "<openssl rand -base64 32>",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "COCKROACH_CLOUD_API_KEY": "...",
    "COCKROACH_CLOUD_CLUSTER_ID": "...",
    "AWS_ACCESS_KEY_ID": "...",
    "AWS_SECRET_ACCESS_KEY": "..."
  }'
```

Secrets are injected as environment variables in the ECS task definition — never in plaintext
in code, Dockerfiles, or logs.

---

## Step 5 — Database (already provisioned)

```bash
psql "$COCKROACHDB_URL&sslrootcert=system" \
  -f cloud-surgeon-agent/database/schema.sql
```

> **`drizzle-kit push` does not work against CockroachDB Serverless** (divergences in `VECTOR`
> syntax and `sslrootcert` handling). Always apply `schema.sql` as raw SQL — it is idempotent
> and safe to re-run.

The CDC changefeed is created automatically at API Server startup and posts events to
`/api/internal/cdc`. In production (ECS), the changefeed destination is controlled by the
`CDC_WEBHOOK_URL` environment variable (see Step 6). This endpoint must remain publicly
accessible — CockroachDB changefeed sinks cannot send custom headers, so it is exposed without
`X-API-Key` authentication.

---

## Step 6 — ECS Fargate (API Server only)

```bash
aws ecs create-cluster --cluster-name cloud-surgeon --region us-east-1
```

Task definition (current revision: **4**):
```json
{
  "family": "cloud-surgeon-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT>:role/cloud-surgeon-task-role",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT>:role/ecsTaskExecutionRole",
  "containerDefinitions": [{
    "name": "api",
    "image": "<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api:latest",
    "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
    "environment": [
      { "name": "PORT",                 "value": "8080" },
      { "name": "NODE_ENV",             "value": "production" },
      { "name": "AI_PROVIDER",          "value": "mistral" },
      { "name": "AWS_REGION",           "value": "us-east-1" },
      { "name": "ECS_DEFAULT_CLUSTER",  "value": "cloud-surgeon" },
      { "name": "ECS_DEFAULT_SERVICE",  "value": "api" },
      { "name": "CALIBRATION_THRESHOLD","value": "0.15" },
      {
        "name":  "CDC_WEBHOOK_URL",
        "value": "https://<distribution>.cloudfront.net/api/internal/cdc"
      }
    ],
    "secrets": [
      { "name": "COCKROACHDB_URL",            "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACHDB_URL::" },
      { "name": "CLOUD_SURGEON_API_KEY",      "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:CLOUD_SURGEON_API_KEY::" },
      { "name": "BEDROCK_API_KEY",            "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:BEDROCK_API_KEY::" },
      { "name": "COCKROACH_CLOUD_API_KEY",    "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACH_CLOUD_API_KEY::" },
      { "name": "COCKROACH_CLOUD_CLUSTER_ID", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACH_CLOUD_CLUSTER_ID::" },
      { "name": "SESSION_SECRET",             "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:SESSION_SECRET::" },
      { "name": "AWS_ACCESS_KEY_ID",          "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:AWS_ACCESS_KEY_ID::" },
      { "name": "AWS_SECRET_ACCESS_KEY",      "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:AWS_SECRET_ACCESS_KEY::" },
      { "name": "COCKROACH_API_KEY",          "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACH_API_KEY::" },
      { "name": "CDC_WEBHOOK_SECRET",         "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:CDC_WEBHOOK_SECRET::" },
      { "name": "VOYAGE_API_KEY",             "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:VOYAGE_API_KEY::" },
      { "name": "DASHBOARD_PASSWORD",         "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:DASHBOARD_PASSWORD::" }
    ],
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:8080/api/healthz || exit 1"],
      "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30
    },
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/cloud-surgeon-api",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "api"
      }
    }
  }]
}
```

**`CDC_WEBHOOK_URL`** — this variable tells the API Server which public URL to use when
creating (or validating) the CockroachDB changefeed sink in production. Without it, the server
falls back to 2-second polling because `REPLIT_DEV_DOMAIN` is not set in ECS. With it, the
existing changefeed is reused automatically on every container restart: `[CDC] Existing
CockroachDB changefeed reused — streaming to webhook`.

**`AI_PROVIDER=mistral`** (current default): routes `invokeLLMThought()` / `invokeLLMText()`
through `src/lib/bedrock-mantle.ts` which calls
`https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions` with a Bearer `BEDROCK_API_KEY`
(no SigV4). If mantle returns null (network error, quota exceeded), the code automatically
falls back to Nova Lite via Bedrock Converse API. To switch models without a redeploy, set the
`BEDROCK_MANTLE_MODEL` environment variable (e.g. `deepseek.v3.2`).

**`AI_PROVIDER=bedrock`**: uses Amazon Nova Lite via Bedrock Converse API with SigV4
(`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`). No BEDROCK_API_KEY required.

**`AI_PROVIDER=anthropic`**: calls Claude via `ANTHROPIC_API_KEY` or the Replit AI
Integrations proxy. Kept as an alternative but not the default — Anthropic is geo-restricted
from Replit's server IP ranges (ECS is unaffected).

**IAM note**: `ecsTaskExecutionRole` requires an inline policy granting
`secretsmanager:GetSecretValue` on the `cloud-surgeon/prod` secret ARN. The managed
`AmazonECSTaskExecutionRolePolicy` does **not** include this. Without it, ECS fails at
container start with `ResourceInitializationError: AccessDeniedException`. Apply:
```bash
aws iam put-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-name cloud-surgeon-secrets-access \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Action":["secretsmanager:GetSecretValue"],
    "Resource":"arn:aws:secretsmanager:us-east-1:153983052396:secret:cloud-surgeon/prod-k366bu"}]}'
```

```bash
aws ecs create-service \
  --cluster cloud-surgeon \
  --service-name api \
  --task-definition cloud-surgeon-api \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:...:api-tg,containerName=api,containerPort=8080"
```

---

## Step 7 — CloudFront (single public entry point)

```
CloudFront distribution
  Origin 1: S3 (dashboard-<suffix>)     — Origin Access Control, default behaviour /*
  Origin 2: ALB (cloud-surgeon-api)     — behaviour /api/* (cache disabled, all headers forwarded)
  ACM certificate (us-east-1)           — demo domain or default CloudFront domain
```

Security groups:
```
ALB Security Group:
  - Inbound: 443 from CloudFront (managed prefix `com.amazonaws.global.cloudfront.origin-facing`)
API Task Security Group:
  - Inbound: 8080 from ALB Security Group only
  - Outbound: 443 (CockroachDB Cloud API, cockroachlabs.cloud/mcp, api.anthropic.com)
  - Outbound: 26257 (CockroachDB Serverless SQL)
```

---

## Step 8 — CloudWatch → SNS → Agent (real alert ingestion)

> **Per-deployment, one-time setup.** Each customer who self-hosts Cloud-Surgeon must run these
> commands once against their own AWS account. This is the infrastructure wiring step — no code
> changes are required.

```bash
# 1. Create the SNS topic
aws sns create-topic --name cloud-surgeon-alerts --region us-east-1

# 2. Subscribe the webhook endpoint
#    SNS immediately sends a SubscriptionConfirmation POST to the URL.
#    The webhook auto-confirms it (fetches the SubscribeURL), no manual step needed.
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts \
  --protocol https \
  --notification-endpoint https://<distribution>.cloudfront.net/api/webhook/cloudwatch \
  --region us-east-1

# 3. ALB 5xx spike alarm — triggers if ≥ 10 errors in three consecutive 60s periods
aws cloudwatch put-metric-alarm \
  --alarm-name checkout-5xx-spike \
  --alarm-description "Cloud-Surgeon: ALB 5xx spike — triggers the AI repair pipeline" \
  --alarm-actions arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts \
  --metric-name HTTPCode_Target_5XX_Count \
  --namespace AWS/ApplicationELB \
  --statistic Sum \
  --period 60 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 3 \
  --treat-missing-data notBreaching \
  --region us-east-1

# 4. ECS CPU pre-alarm — preventive alert before full saturation
aws cloudwatch put-metric-alarm \
  --alarm-name ecs-cpu-high \
  --alarm-description "Cloud-Surgeon: ECS CPU > 80% — preventive pre-alarm" \
  --alarm-actions arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts \
  --metric-name CPUUtilization \
  --namespace AWS/ECS \
  --dimensions Name=ClusterName,Value=cloud-surgeon Name=ServiceName,Value=api \
  --statistic Average \
  --period 60 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --treat-missing-data notBreaching \
  --region us-east-1
```

### How the webhook auto-confirms SNS subscriptions

When SNS subscribes to an HTTPS endpoint it immediately sends a `SubscriptionConfirmation`
POST with `Content-Type: text/plain` (not `application/json`). The webhook at
`POST /api/webhook/cloudwatch` (`artifacts/api-server/src/routes/webhook.ts`) handles this
transparently:

1. Express is configured to parse `text/plain` bodies as JSON
   (`express.json({ type: 'text/plain' })` in `app.ts`).
2. The `SnsSubscriptionConfirmation` Zod schema matches the body (`Type`, `SubscribeURL`, `Token`, `TopicArn`).
3. The handler fetches `SubscribeURL` immediately (a GET to `sns.amazonaws.com`), which activates
   the subscription without any manual step.

No operator action is needed after running `aws sns subscribe` — the subscription confirms itself
within seconds.

### SNS → Agent reliability: SQS Dead-Letter Queue

By default, if the API server returns HTTP 4xx during SNS delivery (e.g. the ECS task was
mid-restart), the notification is lost. Configure a DLQ + retry policy to guarantee delivery:

```bash
# 1. Create the DLQ (receives messages that fail after all retries)
aws sqs create-queue \
  --queue-name cloud-surgeon-sns-dlq \
  --region us-east-1

DLQ_URL=$(aws sqs get-queue-url --queue-name cloud-surgeon-sns-dlq \
  --query QueueUrl --output text --region us-east-1)
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text --region us-east-1)

# 2. Attach the DLQ to the SNS subscription (redrive policy)
#    Retrieve the subscription ARN first (shown after `aws sns subscribe`).
aws sns set-subscription-attributes \
  --subscription-arn arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts:<SUB_ID> \
  --attribute-name RedrivePolicy \
  --attribute-value "{\"deadLetterTargetArn\":\"$DLQ_ARN\"}"

# 3. Set a retry delivery policy: 3 attempts with exponential backoff (5 s → 60 s)
aws sns set-subscription-attributes \
  --subscription-arn arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts:<SUB_ID> \
  --attribute-name DeliveryPolicy \
  --attribute-value '{
    "healthyRetryPolicy": {
      "numRetries": 3,
      "minDelayTarget": 5,
      "maxDelayTarget": 60,
      "numNoDelayRetries": 0,
      "numMinDelayRetries": 1,
      "numMaxDelayRetries": 1,
      "backoffFunction": "exponential"
    }
  }'

# 4. CloudWatch alarm on DLQ depth (alert if messages pile up)
aws cloudwatch put-metric-alarm \
  --alarm-name cloud-surgeon-dlq-depth \
  --alarm-description "SNS notifications stuck in dead-letter queue" \
  --metric-name ApproximateNumberOfMessagesVisible \
  --namespace AWS/SQS \
  --dimensions Name=QueueName,Value=cloud-surgeon-sns-dlq \
  --statistic Sum --period 60 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --evaluation-periods 1 --treat-missing-data notBreaching \
  --region us-east-1
```

**Idempotency note**: the webhook handler uses `alertFingerprint` (SHA-256 of the alarm text)
as a deduplication key. Retried SNS deliveries of the same alarm reuse the same incident row
and skip re-running the agent loop if the incident is already in a terminal state (`RESOLVED`
or `FAILED`), so retries are safe.

### Testing the full pipeline (without real traffic)

```bash
# Force the alarm into ALARM state — triggers the real CloudWatch → SNS → webhook → agent loop
aws cloudwatch set-alarm-state \
  --alarm-name checkout-5xx-spike \
  --state-value ALARM \
  --state-reason "Manual test — Cloud-Surgeon demo" \
  --region us-east-1

# Reset after the demo
aws cloudwatch set-alarm-state \
  --alarm-name checkout-5xx-spike \
  --state-value OK \
  --state-reason "Reset after demo" \
  --region us-east-1
```

The resulting incident appears in the dashboard under **Live Diagnostic** and **All Incidents**
within a few seconds. Triggering the same `AlarmName` multiple times reuses the same incident
fingerprint (resume semantics, not duplicate creation).

---

## Step 9 — Environment variable reference (ECS task, API Server)

| Variable | Demo value | Source |
|---|---|---|
| `PORT` | `8080` | fixed |
| `NODE_ENV` | `production` | fixed |
| `AI_PROVIDER` | `anthropic` | fixed (Bedrock quota disabled) |
| `ANTHROPIC_API_KEY` | — | Secrets Manager |
| `AWS_REGION` | `us-east-1` | fixed |
| `AWS_ACCESS_KEY_ID` | — | Secrets Manager (required by `aws.ts` — SDK default chain not used) |
| `AWS_SECRET_ACCESS_KEY` | — | Secrets Manager |
| `COCKROACHDB_URL` | — | Secrets Manager |
| `CLOUD_SURGEON_API_KEY` | — | Secrets Manager |
| `SESSION_SECRET` | — | Secrets Manager |
| `COCKROACH_CLOUD_API_KEY` | — | Secrets Manager |
| `COCKROACH_CLOUD_CLUSTER_ID` | — | Secrets Manager |
| `ECS_DEFAULT_CLUSTER` | `prod-cluster` | fixed |
| `CALIBRATION_THRESHOLD` | `0.15` | fixed |
| `CDC_WEBHOOK_URL` | `https://<distribution>.cloudfront.net/api/internal/cdc` | fixed — enables CDC in production; without it the server falls back to 2-second polling |
| `CDC_WEBHOOK_SECRET` | — | Secrets Manager — shared-secret token appended to the changefeed sink URL (`?token=<value>`) and validated by `POST /api/internal/cdc`. Generate with `openssl rand -hex 32`. Leave blank in local dev. |
| `COCKROACH_API_KEY` | same value as `COCKROACH_CLOUD_API_KEY` | fixed — the ccloud CLI binary reads this env var for headless auth (shorter name, no `_CLOUD_` infix). Set in the task definition alongside `COCKROACH_CLOUD_API_KEY`. |

Dashboard (build-time only — `VITE_*` variables are inlined by Vite, not read at runtime):

| Variable | Demo value |
|---|---|
| `VITE_API_BASE_URL` | *(vide)* — chemin relatif `/api/...` résolu par le navigateur ; CloudFront route `/api/*` → ALB |
| `VITE_API_KEY` | value of `CLOUD_SURGEON_API_KEY` |
| `VITE_DASHBOARD_PASSWORD` | demo password (see `MIGRATION_REACT.md`) |

---

## Step 10 — Go-live checklist

```
✅ COCKROACH_CLOUD_API_KEY + COCKROACH_CLOUD_CLUSTER_ID set → Managed Cloud MCP LIVE
✅ CockroachDB schema applied (psql schema.sql)
✅ API Server Docker image built and pushed to ECR (current: task-def revision 4)
✅ Secrets created in Secrets Manager (Anthropic direct API, not Bedrock)
✅ ECS cluster created, service `api` started (1 task), health check green
✅ Dashboard build pushed to S3, CloudFront distribution created (OAC, no direct bucket access)
✅ CloudFront /api/* → ALB behaviour validated
✅ GET https://d3ddnpg3hz3st4.cloudfront.net/api/healthz → 200 {"status":"ok"}
✅ Dashboard accessible at the CloudFront domain root
✅ SNS topic created and webhook subscription confirmed (auto-confirmed by the webhook handler)
✅ CloudWatch alarms created: checkout-5xx-spike · ecs-cpu-high
✅ End-to-end test: aws cloudwatch set-alarm-state → incident visible in dashboard within seconds
✅ IAM task role scoped to specific ARNs (see §1.2) — no longer Resource: * for ECS/RDS/Lambda
✅ Docker image revision 6 built and pushed (ccloud binary + node:24-slim + curl for health check)
✅ IAM task role policy updated (scoped ARNs)
✅ COCKROACH_API_KEY + CDC_WEBHOOK_SECRET added to Secrets Manager and ECS task definition (rev 6)
✅ Schema migration applied (playbooks table idempotent)
✅ Dashboard rebuilt and pushed to S3 (CloudFront invalidation triggered)
✅ ECS service updated to task-def revision 6 — steady state reached
□  Create SQS DLQ + configure SNS subscription delivery policy (see §8 SQS section)
□  Seed vector memory: POST /api/metrics/seed (enables win-rate routing and playbook generation)
□  Chaos test: POST /api/chaos/sigkill → agent resumes from last persisted turn

**Fix note (rev 5 → rev 6)**: `node:24-slim` (Debian bookworm-slim) does not include `curl`.
The ECS container health check (`CMD-SHELL curl -f http://localhost:8080/api/healthz`) was silently
failing — curl was missing, so the command exited non-zero while the app itself was healthy (ALB
health checks were passing, visible as 200s in application logs). Fix: `RUN apt-get install -y curl`
in the runtime stage of `Dockerfile.api`.
```

---

## Cost estimate (demo, moderate usage)

| Service | Estimated cost |
|---|---|
| ECS Fargate 1 task (0.5 vCPU / 1 GB) | ~$10–15 / month |
| ALB | ~$20 / month |
| CloudFront + S3 | < $2 / month (demo traffic) |
| ECR storage | < $1 / month |
| CloudWatch logs | < $5 / month |
| SNS | < $1 / month (demo volume) |
| CockroachDB Serverless | Free tier |
| Anthropic API (Claude) | Pay-per-token |
| **Total** | **~$40–45 / month** |

---

## What is NOT needed

- ❌ Lambda — the Express server handles everything, including the MCP tool server as a subprocess
- ❌ API Gateway — CloudFront + ALB is sufficient for HTTP routing
- ❌ RDS — CockroachDB Serverless is already cloud-hosted
- ❌ ElastiCache — no Redis state required
- ❌ ECS/Fargate for the dashboard — it is a static artifact; S3 + CloudFront is cheaper and simpler
- ❌ Bedrock for this demo — quota disabled; `AI_PROVIDER=anthropic` covers the same functionality without code changes

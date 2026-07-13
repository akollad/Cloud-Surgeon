# AWS Marketplace Plan — Self-Install on Buyer Infrastructure

## Sales model (confirmed)

The buyer finds Cloud-Surgeon in AWS Marketplace, clicks **Deploy**, and Cloud-Surgeon installs itself directly into *their* AWS account/infrastructure. This is **not** a vendor-hosted SaaS — we never run or see the buyer's incident data on our own infrastructure. The buyer owns the deployment, the compute, and the data; we sell the software (and optionally support/updates).

This constraint picks the Marketplace product type for us: **AWS Marketplace CloudFormation (CFN) product**, distributed as a container image via **Amazon ECR** (public or shared with the buyer's account) plus a CloudFormation template that provisions everything. AMI is the alternative but is heavier (a full OS image to patch/version) for what is really just one Node.js service + a Postgres-compatible DB; CFN + container keeps us aligned with how the project already runs (see `artifacts/api-server/build.mjs`, Express + Node 24).

| Option | Verdict |
|---|---|
| **SaaS Contract / metered SaaS** | ❌ Wrong model — implies we host it and meter usage on our infra. Buyer wants it in *their* account. |
| **AMI product** | Possible but heavier to maintain (full OS lifecycle, AMI per region, longer patch cycle) for a single containerized service. |
| **Container product (ECS/EKS) via CloudFormation** | ✅ Chosen. Buyer's account runs the container; we ship the image + a CFN template that wires it to their VPC, RDS/CockroachDB, and IAM roles for the AWS APIs it inspects/repairs. |

## What "click Deploy" actually does

1. Buyer clicks **Deploy** on the Marketplace listing → AWS opens the **CloudFormation console** pre-filled with our template's S3 URL (standard Marketplace CFN flow — no custom installer needed).
2. Buyer fills in a handful of parameters (VPC/subnets to deploy into, DB connection option — see below, an admin password or SSO config for the dashboard gate, which AWS regions/services to allow the agent to touch).
3. CloudFormation provisions:
   - An **ECS Fargate service** running the `api-server` container (built from `artifacts/api-server/build.mjs` output) behind an **Application Load Balancer**.
   - A second Fargate service (or the same task, different container) for the `dashboard` static build, or serve it from **S3 + CloudFront** as already noted for the non-Marketplace deployment path in `MIGRATION_REACT.md`.
   - **IAM roles** scoped to exactly the AWS APIs the agent needs to read/repair (CloudWatch, ECS, RDS, Lambda — see `artifacts/api-server/src/mcp/server.ts` for the exact tool surface) — least-privilege, buyer can review/restrict before confirming the stack.
   - Secrets (DB connection string, `CLOUD_SURGEON_API_KEY`, dashboard password, optional `ANTHROPIC_API_KEY`) stored in **AWS Secrets Manager**, referenced by the ECS task definition — never baked into the image.
4. Stack outputs the dashboard URL (ALB DNS or CloudFront domain). Buyer is running, fully inside their own account, in one CFN stack lifecycle (update/delete the stack = update/uninstall the product).

## Database: buyer's choice, no lock-in to us

The agent's persistence layer is CockroachDB Serverless today (`cloud-surgeon-agent/database/schema.sql`), but nothing about the schema is Cockroach-exclusive beyond the vector index syntax (`CREATE VECTOR INDEX`, noted as a gotcha in `replit.md`). For the Marketplace package, offer two documented paths so we're not forcing the buyer into a third-party CockroachDB Cloud account just to try the product:
- **Bring your own CockroachDB Serverless cluster** (buyer pastes a connection string as a CFN parameter — fastest to ship, matches today's code exactly).
- **Provision Amazon Aurora PostgreSQL via the same CFN template**, with a documented follow-up to either drop the vector index (RAG falls back to keyword-only matching, already implemented per `predictive-detection-tests`) or adopt `pgvector` if the schema is ported off Cockroach's vector syntax.

Decide this before the first CFN template draft — it changes what the template provisions.

## Licensing & metering

Since usage happens entirely inside the buyer's account (not observable by us), standard Marketplace **usage-based metering (the Metering API)** doesn't apply — there's no vendor-side API call to meter against. Two realistic options:
- **Annual/monthly flat-fee software license** sold through Marketplace (private offer per buyer, or a public fixed-price listing) — simplest, matches "buyer installs and runs it themselves."
- **BYOL (Bring Your Own License) + private offers** for enterprise buyers who want negotiated terms (support SLA, custom IAM boundary review, etc.) — standard for infrastructure/DevOps tooling sold this way.

Do **not** pursue the AWS Marketplace Metering API unless a later phase adds an explicit "phone home" usage-reporting call from the deployed container back to a vendor-owned endpoint — that's a deliberate architecture change (and a privacy/trust one, since buyers are choosing this precisely to keep their incident data in their own account), not a default.

## Required IAM permissions (buyer-side, granted during CFN deploy)

Minimum set, scoped to what `artifacts/api-server/src/mcp/server.ts`'s tools actually call:
- `cloudwatch:GetMetricData`, `cloudwatch:DescribeAlarms` (diagnosis)
- `ecs:DescribeServices`, `ecs:UpdateService` (ECS repair actions)
- `rds:DescribeDBInstances`, `rds:RebootDBInstance` (RDS repair actions)
- `lambda:GetFunctionConcurrency`, `lambda:PutFunctionConcurrency` (Lambda repair actions)
- No `iam:*`, no cross-account access, no access outside the resources tagged for the deployed stack — enforce with an IAM condition on resource tags set by the CFN template.

## What changes in the codebase to support this (scope for implementation, not yet built)

- `artifacts/api-server` already reads all config from env vars (`AI_PROVIDER`, `COCKROACHDB_URL`, `CLOUD_SURGEON_API_KEY`, AWS creds) — no code change needed there, only a CFN template that populates them from Secrets Manager.
- `artifacts/dashboard`'s new `LoginGate` (`VITE_DASHBOARD_PASSWORD`) is the "hackathon" auth; for a real Marketplace buyer, Phase 2 (Cognito/Amplify, or ALB-native auth — both already scoped in `MIGRATION_REACT.md`) should land before a paid listing goes live, since a single shared password isn't acceptable for a product sold to enterprises.
- New artifact needed: the actual CFN template + a Dockerfile suitable for ECR publishing (the project builds via esbuild already; wrapping that build output in a minimal Node 24 image is the remaining packaging step).

## What you need to obtain outside Replit to execute this

This container has no AWS Marketplace or ECR credentials. Before any of the above can be published:
1. An **AWS Marketplace seller account** (separate registration from a normal AWS account, requires a tax/banking profile).
2. An **ECR repository** (public, or shared per-buyer) to host the container image the CFN template pulls from.
3. Decide and lock in the database path (BYO CockroachDB vs. provisioned Aurora) before drafting the CFN template, since it determines a required vs. optional parameter and what IAM/network resources the template provisions.
4. A support/SLA policy if selling as BYOL with private offers (Marketplace requires you to state one).

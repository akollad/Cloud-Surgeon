---
name: Cloud-Surgeon real AWS deployment layout
description: Where the live demo deployment lives (account, resource names, URLs) and the gotchas hit standing it up.
---

Deployed for real (not simulated) on the user's own AWS account (153983052396, us-east-1) on
2026-07-14, alongside pre-existing unrelated resources on that account (an "Agotels" ECS
cluster/ECR repo) — everything for this project is named `cloud-surgeon-*` to avoid collision.

Stack: ECR + ECS Fargate (`cloud-surgeon` cluster, `api` service) behind an ALB for the Express
API; S3 + CloudFront (with Origin Access Control) for the static React dashboard build;
CloudFront routes `/api/*` to the ALB origin so the whole app is served from one HTTPS domain.
Secrets live in Secrets Manager (`cloud-surgeon/prod`) and are injected into the ECS task via
`secrets`, not plaintext `environment`. Full step-by-step + current live URLs are recorded in
the repo's own `DEPLOYMENT.md` — treat that file as the source of truth for exact endpoints,
IDs, and current status, since those churn (redeploys, teardown, etc.) more than this note does.

**Why this note exists:** two non-obvious runtime bugs had to be fixed before the deployment
would boot/report correctly — see [esbuild external @aws-sdk packages](esbuild-external-aws-sdk-runtime.md)
and [aws.ts hard-requires static keys](aws-hard-requires-static-keys.md). Also, the AI-provider
boot-log diagnostic in `index.ts` only recognized the Replit AI Integrations proxy as "LIVE" for
Anthropic and mislabeled the direct-`ANTHROPIC_API_KEY` fallback path as "no API key" even
though `lib/llm.ts` was already using it successfully — fixed to check both paths.

**How to apply:** before redeploying, rebuild the Docker image (`Dockerfile.api` at repo root)
with the current `node_modules`, push to ECR, then `aws ecs update-service --force-new-deployment`.
`vite build` for the dashboard needs both `PORT` and `VITE_*` vars set or it throws.

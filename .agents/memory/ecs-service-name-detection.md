---
name: ECS service name detection
description: How Cloud-Surgeon resolves real AWS service names from alert text; the bug history and the fix.
---

# ECS service name detection

## The rule
`detectServiceName()` in `cloud-surgeon.ts` must return `"cloud-surgeon/api"` (the real ECS cluster/service) for any alert that doesn't explicitly name a Lambda function. Generic fallbacks like `"ecs-service"`, `"rds-instance"`, `"ec2-instance"`, `"auto-detected-service"` cause AWS API calls to fail with "Cluster not found" / "Service not found."

**Why:** The real infra is: ECS cluster `cloud-surgeon`, service `api`. No RDS (CockroachDB Serverless). No EC2 (Fargate). Lambda only if explicitly named. Any other service name → immediate AWS 404.

**How to apply:** Control via `ECS_DEFAULT_CLUSTER` and `ECS_DEFAULT_SERVICE` env vars (set in both Replit shared and ECS task definition). The function checks for a `'quoted-name'` in the alert text first, then returns `${ECS_DEFAULT_CLUSTER}/${ECS_DEFAULT_SERVICE}` as the fallback.

## The fallback routing in aws_repair_service (MCP tool)
- Lambda → `repairLambdaConcurrency(functionName)` (only when Lambda exists)
- RDS + `RDS_INSTANCE_IDENTIFIER` set → `repairRdsConnections($RDS_INSTANCE_IDENTIFIER)`
- RDS without that env var → ECS check + note "no RDS, use crdb_cluster_health"
- Everything else (ECS, EC2, disk, generic) → `repairEcsService(cluster, service)` with real params from `extractEcsParams()`

## What extractEcsParams does
Splits `"cluster/service"` on `/`. If only one part (no `/`), uses `ECS_DEFAULT_CLUSTER ?? "cloud-surgeon"` and `ECS_DEFAULT_SERVICE ?? "api"` — never `"prod-cluster"` (that was the original bug).

## Stuck TRIGGERED incidents — startup recovery
Added in `index.ts`: on boot, scans for incidents with `status=TRIGGERED`, `claimed_by_agent IS NULL`, `triggered_at` older than 2 minutes, and re-runs `runAgentLoop` for each via `setImmediate`. This recovers incidents where the container crashed between row creation and agent loop start. Detected 6 such incidents on the first boot after the fix.

---
name: MUTATION_ACTIONS set mismatch
description: The auditor's MUTATION_ACTIONS set in cloud-surgeon.ts must use the exact actionTaken strings from aws.ts and mcp/server.ts — not abbreviated or generic names.
---

# MUTATION_ACTIONS / describeActions string mismatch

## The rule
The `MUTATION_ACTIONS` set and `describeActions` set in `cloud-surgeon.ts` (Auditor phase, `verify_resolution` handler) must match the **exact** `actionTaken` string values returned by `aws.ts` and `mcp/server.ts crdb_skill_repair`. Any mismatch silently makes `actionPerformed = false`, so the auditor emits `verdict: "NO_ACTION_REQUIRED"` even after a real mutation.

## Why
The original set contained `"UPDATE_SERVICE"`, `"FORCE_NEW_DEPLOYMENT"`, and `"MODIFY_DB_INSTANCE"` — strings that never appear in the code. The real values are:
- ECS repair success → `"UPDATE_SERVICE_FORCE_DEPLOYMENT"` (repairEcsService)
- ECS rollback → `"ROLLBACK_FORCE_DEPLOYMENT"` (rollbackEcsService)
- RDS repair → `"MODIFY_DB_INSTANCE_PARAM_GROUP"` (repairRdsConnections)
- RDS rollback → `"ROLLBACK_PARAMETER_GROUP"` (rollbackRdsParameterGroup)
- Lambda scale → `"PUT_FUNCTION_CONCURRENCY"` (repairLambdaConcurrency)
- Lambda rollback → `"ROLLBACK_CONCURRENCY"` (rollbackLambdaConcurrency)
- CRDB all branches → diagnostic strings (CRDB_HOTSPOT_DIAGNOSED, CRDB_INDEX_DIAGNOSED, etc.) — all read-only

## How to apply
Whenever a new tool or new `actionTaken` string is added to `aws.ts` or `mcp/server.ts`, update the two sets in `cloud-surgeon.ts` (around the Auditor phase, `callTool("verify_resolution", ...)` block) in sync. The sets are documented with `// Must match the exact actionTaken strings from aws.ts...` comments as a reminder.

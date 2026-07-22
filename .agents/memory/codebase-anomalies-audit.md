---
name: Codebase anomalies audit — full pass
description: All anomalies found and fixed in a systematic audit of timelines, logs, repair plans, rollbacks, CDC, MCP, routing, coordination, and seed data.
---

# Codebase anomalies audit — complete pass

## Fixes applied (production bugs)

### repair-strategies.ts — commandsExecuted reads wrong field
`generateAndStoreRollbackPlan` read `toolOutput.action` (never exists in `AwsToolResult` or `crdb_skill_repair`). Fixed to `toolOutput.actionTaken`. Also fixed: `toolOutput.steps`/`detail` (non-existent) replaced with `toolOutput.actionsApplied` (CRDB) and `toolOutput.recommendation`/`toolOutput.outcome` (AWS/CRDB).

**Why:** Every rollback panel showed a generic fallback string instead of the actual action executed.

### memory.ts — findSimilarIncident missing try/catch
The vector ANN query threw an unhandled rejection on embedding dimension mismatch (e.g. after model change). Wrapped in try/catch returning undefined, so routing gracefully falls back to PENDING_APPROVAL.

### cloud-surgeon.ts — MUTATION_ACTIONS set contained phantom strings
`"UPDATE_SERVICE"`, `"FORCE_NEW_DEPLOYMENT"`, `"MODIFY_DB_INSTANCE"` never appear in aws.ts. Real values: `"UPDATE_SERVICE_FORCE_DEPLOYMENT"`, `"MODIFY_DB_INSTANCE_PARAM_GROUP"`. This caused `actionPerformed=false` for every real ECS/RDS repair → auditor verdict was always `NO_ACTION_REQUIRED` instead of `PASS`.

### cloud-surgeon.ts — describeActions set missing CRDB diagnostic strings
All `crdb_skill_repair` actionTaken values (`CRDB_HOTSPOT_DIAGNOSED` etc.) were absent from `describeActions`. Added all 6 read-only CRDB action names.

### metrics.ts — MTTR by-strategy used triggered_at, global MTTR used agentStartedAt
Inconsistency: per-strategy breakdown excluded human review time (used triggered_at) while global MTTR correctly excluded it (used agentStartedAt via COALESCE). Fixed per-strategy SQL to match global formula.

### mcp/server.ts — ECS "database" keyword collision
An ECS service named "database-service" without a "/" was misrouted to the CRDB redirect branch when `!hasRds`. Added `!isDefinitelyEcs &&` guard so slash-named ECS services are never intercepted.

### mcp/server.ts — crdb_query accepted DDL/DML
No SELECT-only enforcement at the server code level. Added trimStart+lowercase check: only SELECT, SHOW, EXPLAIN are permitted. Write operations are rejected with an explicit error.

### cdc.ts — paused/failed changefeeds silently ignored
Query filtered only `status = 'running'`. A paused or failed changefeed was not found, so a duplicate was created (two changefeeds → duplicate CDC events). Fixed: query now includes paused/failed; paused jobs are RESUMED (preserving cursor), failed jobs are CANCELLED before CREATE.

### seed-demo-incidents.ts — RESOLVED incidents had NULL resolved_at
The INSERT did not include `resolved_at`. MTTR SQL correctly excludes rows with NULL resolved_at, so all demo incidents were invisible to MTTR metrics. Fixed: added `resolved_at = updatedAt` and `agentStartedAt` (30s after trigger) for RESOLVED incidents.

### coordination.ts — releaseIncidentClaim could strip another agent's lock
Unconditional `UPDATE SET claimed_by_agent = NULL` — no check on who currently holds the claim. A crashed agent's late recovery could strip a claim taken by the next agent. Fixed: added optional `agentName` parameter; when provided, WHERE clause adds `AND claimed_by_agent = $agentName`. Startup force-release remains unconditional.

## Remaining architectural notes (not bugs, design choices)

- **Claim timeout**: no TTL on claimed incidents. Startup recovery covers TRIGGERED/DIAGNOSING stuck > 5 min, but REPAIRING stuck (mid-Phase 1 crash) requires manual retry. By design.
- **Duplicate handoffs**: `agent_handoffs` has no unique constraint on (incident_id, agent_name). Retries can insert duplicates. Low impact (display only), not fixed.
- **Auth dual-key**: static API key + JWT are both accepted. Leaked key bypasses JWT expiry. Deliberate for demo flexibility.
- **crdbMcp msgId**: not atomic, but Node.js event loop makes concurrent mutation safe in practice.
- **ROLLBACK_CMDS_NO_FAILURE_LABEL / correctionFactor null** etc.: patched in DB by previous session, code already fixed before this audit.

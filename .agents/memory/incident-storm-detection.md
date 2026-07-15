---
name: Incident storm detection architecture
description: How Cloud-Surgeon detects cascade failures and prevents autonomous repair from amplifying them.
---

## Rule
When 3+ semantically similar incidents arrive within 10 minutes, routing is forced to `PENDING_APPROVAL` regardless of win-rate. Autonomous repair during a cascade would risk amplifying the outage.

## Implementation
- `detectIncidentStorm(embedding, options)` in `cloud-surgeon.ts`: one SQL query with `JOIN incident_state` + timestamp window + `embedding <=> $1::vector < maxDistance`.
- Called in `artifacts/api-server/src/routes/webhook.ts` in parallel with `findSimilarIncident()` (same embedding, both run in `Promise.all`).
- Storm metadata merged into `context_json` via `pool.query("UPDATE ... SET context_json = context_json || $1::jsonb")` (JSONB merge operator `||`, not overwrite).
- In `runAgentLoop`: `stormDetected` flag is read from `context_json` before `computeRoutingMode()`; if true, routing is hardcoded to `PENDING_APPROVAL`.
- 202 response from webhook includes `stormDetected: true` and `relatedIncidentsInWindow` for client awareness.

**Why:** Autonomous restart of ECS services during a VPC-level failure or bad deployment rollout would restart all services simultaneously, making recovery harder. Human coordination is required.

**How to apply:** No configuration needed — the feature is active whenever the vector memory has data. Thresholds configurable via `detectIncidentStorm` options: `windowMinutes` (default 10), `maxDistance` (default 0.35), `minCount` (default 3).

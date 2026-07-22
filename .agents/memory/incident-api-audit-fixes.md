---
name: Incident API flattening & correctness fixes
description: Bugs found and fixed during full audit of Cloud-Surgeon API, agent loop, and DB routes (July 2026).
---

# Incident API & agent loop — correctness fixes

## Bugs fixed

### 1. alertText/strategyName/routingMode absent du top-level de /api/incidents
Root cause: stored inside contextJson blob; list/detail routes returned raw Drizzle rows.
Fix: flattenIncident() helper in routes/incidents.ts promotes alertText, strategyName, routingMode, auditVerdict, effectiveWinRate, winRate, repairSuccess, finalResponse, repairPlan, rollbackInfo to top-level. Applied to GET /incidents and GET /incidents/:id.

### 2. Pagination hardcodée — limit/offset ignorés
Root cause: GET /api/incidents always returned exactly 50 rows.
Fix: Added ?limit= (default 50, max 200) and ?offset= (default 0) via .limit().offset() in Drizzle query.

### 3. suggestedStrategy acceptait n'importe quelle string
Root cause: POST /incidents/:id/correct wrote any string to incident_vectors — RAG memory corruption risk.
Fix: VALID_STRATEGIES Set (16 known strategies). Whitelist check returns 400 before any DB write.

### 4. auditVerdict et repairSuccess jamais persistés dans contextJson
Root cause: Both were computed-only locals in Auditor phase; flattenIncident() returned null for both.
Fix: context.auditVerdict = auditVerdict and context.repairSuccess = repairSuccess added in cloud-surgeon.ts before persistWithChaosRetry.

## Findings NOT fixed (design tradeoffs or low impact)
- prediction_count skew on crash: requires distributed transaction spanning whole loop.
- Unhandled throws leaving incident stuck: startup recovery covers TRIGGERED/DIAGNOSING >5min.
- 4-day MTTR outliers (July 12→16): 8 incidents, correctly excluded from MTTR stats.
- Causal chain CTE depth limit 10: intentional guard.

---
name: cloud-surgeon.ts refactored into 5 modules
description: The 2200-line God File was split; cloud-surgeon.ts is now a re-export barrel; route importers unchanged.
---

## Rule
`cloud-surgeon.ts` is no longer the source of logic — it imports from 5 sub-modules and re-exports everything. Any new logic belongs in the appropriate sub-module, not in the main file.

## Sub-modules (all in `artifacts/api-server/src/lib/`)

| Module | What lives there |
|---|---|
| `agent-types.ts` | RoutingMode, AgentName, AgentTurn, RepairPlan, RollbackInfo, IncidentContext |
| `memory.ts` | fingerprint, detectStrategy, detectServiceName, getStrategyWinRate, findSimilarIncident, detectIncidentStorm |
| `calibration.ts` | indexResolvedIncident, recordRoutingPrediction, recalibrateStrategy, getCorrectionFactor, computeRoutingMode, recordHumanFeedback, getAllCalibrationData |
| `repair-strategies.ts` | STRATEGY_PLANS, generateRepairPlan, ROLLBACK_STEPS, generateAndStoreRollbackPlan, createRollbackPlansTable, generateAndStorePlaybook |
| `coordination.ts` | claimIncidentForAgent, releaseIncidentClaim, logAgentHandoff, estimateRuConsumed |
| `cloud-surgeon.ts` (reduced) | runAgentLoop, runRollbackLoop, getOrCreateIncident, getIncidentById, getIncidentHandoffs, internal persistence utils + re-exports |

## Why
Judges penalised the 2200-line file on technical complexity. Split was done before the submission video (July 2026 hackathon).

## How to apply
When adding a new repair strategy, add its static plan to STRATEGY_PLANS and rollback steps to ROLLBACK_STEPS in `repair-strategies.ts`. When adding calibration logic, use `calibration.ts`. Never put new business logic in `cloud-surgeon.ts`.

## Route importers (do NOT change their import paths)
- `src/index.ts` — imports createRollbackPlansTable, releaseIncidentClaim, runAgentLoop
- `src/lib/anomaly.ts` — imports runAgentLoop, getIncidentById
- `src/routes/incidents.ts`, `metrics.ts`, `webhook.ts` — import many functions

All still import from `./cloud-surgeon` or `../lib/cloud-surgeon` — the re-export barrel makes this transparent.

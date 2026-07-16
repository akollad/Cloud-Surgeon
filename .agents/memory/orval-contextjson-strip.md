---
name: Orval contextJson field stripping
description: Orval-generated z.object() strips unknown fields from contextJson; any new field on IncidentContext must be declared in openapi.yaml then codegen re-run.
---

## Rule
Any new field stored in `context_json` (repairPlan, rollbackInfo, correctionFactor, etc.) must be explicitly declared in the `IncidentContext` schema in `lib/api-spec/openapi.yaml`.

**Why:** Orval generates `z.object({ ... })` without `.passthrough()` even when `additionalProperties: true` is set. Zod's default strips unknown keys from the parsed response, so fields stored in CockroachDB are lost at the API boundary.

**How to apply:** After adding a field to the IncidentContext interface in cloud-surgeon.ts, add it to openapi.yaml → run `cd lib/api-spec && pnpm run codegen` → rebuild API server (`pnpm run build`).

**Confirmed:** repairPlan/rollbackInfo confirmed stored in DB (has_rp=t, has_ri=t) but missing from API response until codegen fix applied.

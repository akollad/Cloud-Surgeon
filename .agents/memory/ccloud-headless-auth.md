---
name: ccloud CLI headless auth
description: ccloud v0.6.12 credentials.json must use snake_case "api_key", not camelCase "apiKey"; bootstrapCcloudCredentials writes the correct format at startup.
---

# ccloud CLI headless auth

## The rule
ccloud v0.6.12 reads `credentials.json` as `{ "default": { "api_key": "..." } }` (snake_case). Writing camelCase `apiKey` is silently ignored — `ccloud auth whoami` returns "not logged in" even though the file exists and has the correct value.

**Why:** The Go config struct tag is `json:"api_key"` (confirmed via `strings` on the binary). A previous version of `bootstrapCcloudCredentials()` wrote `apiKey` which the binary never parsed.

## How to apply
In `bootstrapCcloudCredentials()` (`artifacts/api-server/src/index.ts`), write:
```json
{ "default": { "api_key": "<COCKROACH_CLOUD_API_KEY>" } }
```
Also write `profiles.json` with org coordinates (organizationId, organizationLabel, organizationName, server, userFullName) — without it, whoami also fails.

With both files correct, `ccloud auth whoami` authenticates headlessly at boot. No browser OAuth needed in Replit dev.

## Files required for headless auth
1. `credentials.json` — `{ "default": { "api_key": "..." } }` — from `COCKROACH_CLOUD_API_KEY`
2. `profiles.json` — `{ "default": { organizationId, organizationLabel, organizationName, server, userFullName } }`
3. `configuration.json` — `{ "publishableKeys": { "segmentCCloudAPIKey": "..." }, "flags": {} }`

All three go in `$XDG_CONFIG_HOME/.cockroachdb/` (resolves to `/home/runner/workspace/.config/.cockroachdb/` on Replit).

## REST fallback (still valid)
If ccloud binary auth fails in ECS/production, call the CockroachDB Cloud REST API directly with the `COCKROACH_CLOUD_API_KEY` Bearer token — same data source as what ccloud wraps.

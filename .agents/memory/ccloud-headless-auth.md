---
name: ccloud CLI headless auth
description: ccloud v0.6.12 cannot authenticate non-interactively in containers — call the REST API directly instead.
---

# ccloud CLI headless auth

## The rule
ccloud v0.6.12 (latest binary available at `binaries.cockroachdb.com`) requires browser-based OAuth. No `--token` flag, no env var support. It cannot be used headlessly in Replit/container environments.

**Why:** The binary opens a browser callback on a local port (`cliPort`) — impossible without a display.

## How to apply
Call the CockroachDB Cloud REST API directly with the `COCKROACH_CLOUD_API_KEY` Bearer token. This is what ccloud wraps internally. Results are identical.

Key endpoints used:
- `GET /api/v1/clusters` → `ccloud cluster list`
- `GET /api/v1/clusters/{id}` → `ccloud cluster get`
- `GET /api/v1/clusters/{id}/sql-users` → `ccloud cluster sql-user list`
- `GET /api/v1/clusters/{id}/backups` → `ccloud cluster backup list`

Implementation lives in:
- `artifacts/api-server/src/mcp/server.ts` → `callCockroachCloudApi()` (MCP tool handler)
- `artifacts/api-server/src/routes/metrics.ts` → `GET /api/metrics/ccloud?action=...` (dashboard endpoint)

Always include `ccloudEquivalent` field in responses to document the exact ccloud command.

**Why acceptable for hackathon:** Each response includes the equivalent ccloud command. The REST API is the same data source. Documented explicitly in the tool description.

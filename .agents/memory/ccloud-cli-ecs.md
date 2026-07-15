---
name: ccloud CLI headless auth in ECS
description: ccloud v0.6.12 cannot authenticate headlessly — REST API fallback is the real working path; binary is present for cosmetic/demo value only.
---

# ccloud CLI in ECS — what actually works

## Confirmed behaviour (live test, July 2026)
`COCKROACH_API_KEY` is set in the ECS task definition with the correct value, but ccloud v0.6.12
still responds: `Error: not logged in. Use 'ccloud auth login' to login`.

**The binary cannot authenticate headlessly.** `ccloud-headless-auth.md` is the authoritative note.

## Dockerfile requirements (still needed)
- Use `node:24-slim` (Debian/glibc) — ccloud is a glibc binary; Alpine (musl) is incompatible.
- Install `ca-certificates` via apt-get — Debian slim ships without the system CA bundle; the binary
  needs it to reach `cockroachlabs.cloud` even if auth ultimately fails.
- `curl` must also be installed for the ECS container health check.

## What actually runs
`callCockroachCloudRestApi()` in `artifacts/api-server/src/mcp/server.ts` — calls the same REST API
that ccloud wraps. Results are identical. Every response includes `cliMode: "rest"` and a
`ccloudEquivalent` field showing the exact ccloud command for transparency.

**Why acceptable:** The REST API is the same data source. Documented explicitly in tool descriptions.

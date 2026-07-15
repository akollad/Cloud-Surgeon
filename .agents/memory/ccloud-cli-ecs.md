---
name: ccloud CLI headless auth in ECS
description: How to run the ccloud binary in a container without browser OAuth — env var name, base image, fallback pattern.
---

## Rule
Set `COCKROACH_API_KEY` (not `COCKROACH_CLOUD_API_KEY`) in the ECS task definition. The ccloud binary reads this shorter name automatically for headless auth (supported since v0.5+).

## Dockerfile requirements
- Use `node:24-slim` (Debian/glibc) for the runtime stage — ccloud is a glibc binary.
- `node:24-alpine` (musl libc) is **incompatible** — do not switch back.
- Download in a separate `debian:bookworm-slim` build stage, then `COPY --from=ccloud`.

## Fallback pattern
`execCcloud()` in `artifacts/api-server/src/mcp/server.ts`:
- Passes `COCKROACH_API_KEY: process.env.COCKROACH_CLOUD_API_KEY` in the child process env.
- Returns `{ ok: false, notFound: true }` when binary is not in PATH (local dev).
- On `notFound`, `callCockroachCloudApi()` falls back to `callCockroachCloudRestApi()`.
- Response always includes `cliMode: "ccloud_binary"` or `"rest"` so the agent knows which path was taken.

**Why:** ccloud v0.6.12 requires browser OAuth in interactive mode; `COCKROACH_API_KEY` env var is the headless bypass. REST fallback ensures local dev continues working without Docker.

**How to apply:** Any time a new ECS task definition is created, add both `COCKROACH_CLOUD_API_KEY` (for the REST API and MCP) and `COCKROACH_API_KEY` (same value, for the ccloud binary).

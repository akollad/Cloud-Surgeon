# Cloud-Surgeon

Autonomous AI DevOps agent that detects, diagnoses, and repairs cloud infrastructure incidents. Built for the CockroachDB × AWS Hackathon 2026.

## Architecture

- **`artifacts/api-server`** — Express 5 + TypeScript backend (AI agent loop, CockroachDB, AWS SDKs). Runs on port 8080.
- **`artifacts/dashboard`** — React 19 + Vite frontend (live incident dashboard with CDC stream). Runs on port 23183 at `/dashboard/`.
- **`lib/db`** — Drizzle ORM schema + CockroachDB connection pool.
- **`lib/api-zod`** — Generated Zod schemas from OpenAPI spec.
- **`lib/integrations-anthropic-ai`** — Anthropic SDK client wrapper.

## How to Run

Two workflows are configured and start automatically:

| Workflow | Command | Port |
|---|---|---|
| **API Server** | `PORT=8080 pnpm --filter @workspace/api-server run dev` | 8080 |
| **Dashboard** | `PORT=23183 BASE_PATH=/dashboard/ pnpm --filter @workspace/dashboard run dev` | 23183 |

The dashboard is visible at `/dashboard/` in the preview pane.
The API is at `/api/` (proxied through the dashboard's Vite dev server).

## Required Secrets

| Secret | Purpose |
|---|---|
| `COCKROACHDB_URL` | CockroachDB Serverless connection string |
| `ANTHROPIC_API_KEY` | Claude API key for the agent loop |

## Pre-configured Env Vars (shared)

- `CLOUD_SURGEON_API_KEY` — API key for all `/api/*` endpoints
- `AI_PROVIDER=anthropic` — LLM provider selection
- `AWS_REGION=us-east-1` — AWS region for ECS/RDS/Lambda calls
- `VITE_API_BASE_URL=/api` — Dashboard → API base path
- `VITE_API_KEY` — Dashboard API key (matches `CLOUD_SURGEON_API_KEY`)

## Key API Endpoints

All endpoints require `X-API-Key: <CLOUD_SURGEON_API_KEY>` header.

- `GET /api/healthz` — Health check
- `POST /api/incidents/trigger` — Trigger an incident from alert text
- `GET /api/incidents` — List incidents
- `GET /api/audit` — Audit log (SSE stream)
- `POST /api/chaos/sigkill` — Simulate crash for chaos demo

## User Preferences

- Keep existing monorepo structure (`pnpm` workspace with `artifacts/` and `lib/`)
- Do not restructure or migrate the stack

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
- `VITE_API_KEY` — Dashboard API key (matches `CLOUD_SURGEON_API_KEY`)
- `VITE_API_BASE_URL` — leave unset; the generated client already includes `/api/` in every path

## Key API Endpoints

All endpoints require `X-API-Key: <CLOUD_SURGEON_API_KEY>` header.

- `GET /api/healthz` — Health check
- `POST /api/incidents/trigger` — Trigger an incident from alert text
- `GET /api/incidents` — List incidents
- `GET /api/audit` — Audit log (SSE stream)
- `POST /api/chaos/sigkill` — Simulate crash for chaos demo

## Known Pitfalls — Do Not Repeat

### ❌ Ne jamais remettre `VITE_API_BASE_URL` à une valeur non-vide

Le client généré (`lib/api-client-react/src/generated/api.ts`) produit déjà des chemins absolus qui commencent par `/api/` (ex: `/api/healthz`, `/api/incidents`). Si `VITE_API_BASE_URL=/api` est défini, `setBaseUrl("/api")` est appelé dans `main.tsx` et **chaque requête devient `/api/api/...`** — double préfixe, 404 garanti.

- **En dev Replit** : le proxy Vite (`vite.config.ts` → `server.proxy`) route `/api` → `localhost:8080`. Les chemins relatifs fonctionnent sans base URL.
- **En prod AWS** : l'ALB route `/api/*` → Express. Même chose, pas de base URL nécessaire.
- `VITE_API_BASE_URL` ne doit être renseigné que pour un API **cross-origin** (ex: staging sur un autre domaine depuis une app mobile). Il est actuellement vide dans les env vars partagés.

### ❌ Ne jamais redéfinir `CCLOUD_BINARY` en inline dans un fichier

La seule source de vérité pour le path du binaire ccloud est **`artifacts/api-server/src/lib/ccloud-path.ts`**. Cette logique tient compte de `NODE_ENV` :
- **Production (ECS)** : `/usr/local/bin/ccloud` (copié par le Dockerfile)
- **Dev (Replit)** : `.tools/ccloud` à la racine du workspace

Tout fichier qui a besoin du binaire doit faire :
```ts
import { CCLOUD_BINARY } from "../lib/ccloud-path";
```
Ne jamais recalculer le chemin inline — c'est ce qui causait des échecs silencieux en ECS où le path prod n'était pas utilisé.

### ccloud auth en production (ECS)

`bootstrapCcloudCredentials()` dans `index.ts` écrit les **3 fichiers** requis par ccloud v0.6.12 au démarrage du container :
1. `credentials.json` — la clé API (`COCKROACH_CLOUD_API_KEY`)
2. `profiles.json` — org info (récupérée via l'API REST CockroachDB Cloud)
3. `configuration.json` — clés SDK non-sensibles

Sans les 3 fichiers, `ccloud auth whoami` renvoie "not logged in" même si la clé est correcte. En dev Replit, le fallback REST est actif donc le manque d'auth ccloud est non-bloquant.

## User Preferences

- Keep existing monorepo structure (`pnpm` workspace with `artifacts/` and `lib/`)
- Do not restructure or migrate the stack

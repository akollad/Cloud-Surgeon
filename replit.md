# Cloud-Surgeon

Autonomous AI DevOps agent that detects, diagnoses, and repairs cloud infrastructure incidents. Built for the CockroachDB × AWS Hackathon 2026.

## Architecture

- **`artifacts/api-server`** — Express 5 + TypeScript backend (AI agent loop, CockroachDB, AWS SDKs). Runs on port 8080.
- **`artifacts/dashboard`** — React 19 + Vite frontend (live incident dashboard with CDC stream). Runs on port 23183 at `/dashboard/`.
- **`lib/db`** — Drizzle ORM schema + CockroachDB connection pool.
- **`lib/api-zod`** — Generated Zod schemas from OpenAPI spec.
- **`lib/integrations-anthropic-ai`** — Anthropic SDK client wrapper (used only when `AI_PROVIDER=anthropic`).

## How to Run

Two workflows are configured and start automatically:

| Workflow | Command | Port |
|---|---|---|
| **API Server** | `PORT=8080 pnpm --filter @workspace/api-server run dev` | 8080 |
| **Dashboard** | `PORT=23183 BASE_PATH=/dashboard/ pnpm --filter @workspace/dashboard run dev` | 23183 |

The dashboard is visible at `/dashboard/` in the preview pane.
The API is at `/api/` (proxied through the dashboard's Vite dev server).

## Required Secrets

| Secret | Purpose | Status |
|---|---|---|
| `COCKROACHDB_URL` | CockroachDB Serverless connection string | ✅ set |
| `BEDROCK_API_KEY` | AWS Bedrock API key | ✅ set |
| `SESSION_SECRET` | Cookie signing secret | ✅ set |

Optional secrets (enable live AWS tool calls):
- `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` — without these, AWS tools run in SIMULATED mode
- `COCKROACH_CLOUD_API_KEY` — for CockroachDB Cloud cluster management via ccloud CLI
- `COCKROACH_CLOUD_CLUSTER_ID` — cluster UUID from CockroachDB Cloud console

## Pre-configured Env Vars (shared)

- `CLOUD_SURGEON_API_KEY` — API key for all `/api/*` endpoints
- `AI_PROVIDER=mistral` — LLM provider (Mistral Large 3 via bedrock-mantle; Nova Lite is automatic fallback)
- `BEDROCK_REGION=eu-west-1` — Bedrock region (used by Nova Lite fallback)
- `AWS_REGION=us-east-1` — AWS region for ECS/RDS/Lambda calls
- `VITE_API_KEY` — Dashboard API key (matches `CLOUD_SURGEON_API_KEY`)
- `VITE_API_BASE_URL` — leave unset; the generated client already includes `/api/` in every path
- `ECS_DEFAULT_CLUSTER=cloud-surgeon` — ECS cluster name
- `ECS_DEFAULT_SERVICE=api` — ECS service name

## Key API Endpoints

All endpoints require `X-API-Key: <CLOUD_SURGEON_API_KEY>` header.

- `GET /api/healthz` — Health check
- `POST /api/incidents/trigger` — Trigger an incident from alert text
- `GET /api/incidents` — List incidents
- `GET /api/audit` — Audit log (SSE stream)
- `POST /api/chaos/sigkill` — Simulate crash for chaos demo

## LLM Provider Architecture

The LLM layer (`artifacts/api-server/src/lib/llm.ts`) routes all reasoning calls through the `AI_PROVIDER` env var:

| `AI_PROVIDER` | Module | Auth | Notes |
|---|---|---|---|
| `mistral` (default) | `bedrock-mantle.ts` | `BEDROCK_API_KEY` Bearer | Mistral Large 3 (675B), OpenAI-compat, no SigV4 |
| `bedrock` | `bedrock.ts` | SigV4 (`AWS_ACCESS_KEY_ID`) | Nova Lite via Converse API |
| `anthropic` | Anthropic SDK | `ANTHROPIC_API_KEY` | Geo-restricted from Replit IPs |

**Fallback chain for `AI_PROVIDER=mistral`**: bedrock-mantle → Nova Lite → simulated template.
Any error from mantle (network, quota) drops to Nova Lite silently; any error from Nova Lite produces a deterministic fallback thought. The `source` field on every `LLMThought` always records which tier actually responded.

To switch models without a code change: set `BEDROCK_MANTLE_MODEL=deepseek.v3.2` (or any other bedrock-mantle-compatible model).

## Known Pitfalls — Do Not Repeat

### ⚠️ `VITE_API_BASE_URL` — origin seulement, jamais origin + `/api`

Le client généré (`lib/api-client-react/src/generated/api.ts`) produit déjà des chemins qui commencent par `/api/` (ex: `/api/healthz`, `/api/incidents`). `setBaseUrl()` dans `custom-fetch.ts` préfixe ces chemins tels quels.

**Règle** : si tu dois définir `VITE_API_BASE_URL`, mets-y **l'origine seule**, sans `/api`.

| Scénario | Valeur correcte | Résultat |
|---|---|---|
| Dev Replit | *(vide)* | proxy Vite `/api` → `localhost:8080` |
| Prod AWS same-origin | *(vide)* | ALB route `/api/*` → Express |
| Cross-origin (mobile, staging) | `https://mon-api.example.com` | `https://mon-api.example.com/api/healthz` ✓ |
| ❌ FAUX | `https://mon-api.example.com/api` | `https://mon-api.example.com/api/api/healthz` 404 |

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

### ⚠️ S3 + CloudFront dashboard deploy — toujours dans cet ordre

Vite génère des filenames hashés (`assets/index-C4ib8eU3.css`). Si tu lances `aws s3 sync --delete` avant que l'invalidation CloudFront soit terminée, les edge nodes servent encore l'ancien `index.html` (avec les anciens hashes) mais les anciens fichiers sont déjà supprimés de S3. CloudFront renvoie alors `index.html` comme fallback, le browser le rejette avec `MIME type "text/html" is not "text/css"`.

**Ordre correct :**
1. `aws s3 sync dist/public/ s3://... --region us-east-1` ← pas de `--delete`
2. `aws cloudfront create-invalidation --paths "/*"` + attendre `aws cloudfront wait invalidation-completed`
3. `aws s3 sync dist/public/ s3://... --delete` ← maintenant safe

### ⚠️ `ecsTaskExecutionRole` — inline policy Secrets Manager requise

`AmazonECSTaskExecutionRolePolicy` (policy AWS managée) ne donne **pas** accès à `secretsmanager:GetSecretValue`. Sans la policy inline `cloud-surgeon-secrets-access`, ECS échoue au démarrage avec `ResourceInitializationError: AccessDeniedException`. Voir DEPLOYMENT.md Step 6 pour la commande exacte.

## User Preferences

- Keep existing monorepo structure (`pnpm` workspace with `artifacts/` and `lib/`)
- Do not restructure or migrate the stack

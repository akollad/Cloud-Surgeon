# Cloud-Surgeon — Plan de déploiement AWS (réel, pour la démo)

> Ce document décrit l'architecture **actuelle** du projet (Express + React, monorepo pnpm)
> et l'infrastructure AWS cible pour un déploiement réel utilisable en démo de hackathon.
> Il remplace l'ancienne version qui décrivait un dashboard Streamlit/Python — abandonné ;
> le dashboard est maintenant une SPA React 19 + Vite (`artifacts/dashboard`).

## Vue d'ensemble de l'architecture

```
Internet (HTTPS)
       │
       ▼
┌───────────────────────────┐
│   Amazon CloudFront        │  (CDN + point d'entrée public unique)
│   https://<distribution>   │
└──────────┬─────────────────┘
           │
   ┌───────┴────────────────────────────┐
   │                                    │
   ▼                                    ▼
/*  → S3 (dashboard React,      /api/* → ALB → ECS Fargate
    build statique Vite)              (API Server Express 5)
                                             │
                                             │ MCP stdio subprocess
                                             │ (bundlé dans le même conteneur)
                                             │
                                             ▼
                                   COCKROACHDB_URL (TLS)
                                             │
                                             ▼
                                  CockroachDB Serverless
                                  (cloud.cockroachlabs.com)

                                   HTTPS Bearer (COCKROACH_CLOUD_API_KEY)
                                             │
                                             ▼
                                  cockroachlabs.cloud/mcp
                                  (MCP Cloud managé — cluster health,
                                   slow queries, SQL diagnostique)

AWS CloudWatch Alarm ──▶ SNS Topic ──▶ POST /api/webhook/cloudwatch (ALB)
```

## Services à déployer

| Service | Technologie | Port | Hébergement |
|---|---|---|---|
| **API Server** (agent loop + REST + MCP client) | Node.js 24 / Express 5 / TypeScript | 8080 | ECS Fargate |
| **MCP Tool Server** (`aws_repair_service`, `execute_ccloud_command`, `crdb_*`) | Node.js (subprocess stdio) | — | Bundlé dans le conteneur API Server, aucun service séparé |
| **Dashboard** | React 19 / Vite (SPA statique) | — | S3 + CloudFront |
| **Base de données / mémoire agent** | CockroachDB Serverless | 26257 | Cloud (déjà actif) |

Il n'y a **pas** de composant Python/Streamlit dans le déploiement — le dashboard est un
build statique (`pnpm --filter @workspace/dashboard run build` → `artifacts/dashboard/dist/public`)
servi directement depuis S3, sans serveur Node à faire tourner pour lui.

---

## Étape 0 — CockroachDB Cloud : les deux outils CockroachDB utilisés en réel

Le projet utilise deux des quatre outils CockroachDB requis par le hackathon :

1. **Distributed Vector Indexing** — `incident_vectors.embedding VECTOR(1024)` +
   `CREATE VECTOR INDEX ... USING C-SPANN` dans `cloud-surgeon-agent/database/schema.sql`.
   Actif dès que `COCKROACHDB_URL` pointe vers le cluster Serverless.
2. **CockroachDB Cloud Managed MCP Server** — `crdb_cluster_health`, `crdb_list_slow_queries`,
   `crdb_query` dans `artifacts/api-server/src/mcp/server.ts` appellent réellement
   `https://cockroachlabs.cloud/mcp` (StreamableHTTP + Bearer `COCKROACH_CLOUD_API_KEY`).
   Ces trois outils sont **inactifs sans cette clé** — c'est le premier prérequis à fournir
   avant toute démo.

**Sur le ccloud CLI (le 3ᵉ outil listé par le règlement) :** le binaire `ccloud` (testé ici,
absent de ce conteneur, et documenté à la v0.6.12 comme nécessitant un flow OAuth navigateur)
ne peut pas s'authentifier de façon headless dans un environnement serveur/CI/conteneur —
il n'y a pas de navigateur pour compléter le login. C'est un constat, pas une esquive :
Cloud-Surgeon appelle directement l'API REST que `ccloud` encapsule
(`https://cockroachlabs.cloud/api/v1/clusters/...`), avec la même clé de service-account,
pour obtenir des résultats identiques (`cluster:status`, `cluster:list`, `cluster:sql-users`,
`cluster:backups`, `cluster:version`, `cluster:sql-dns`). Chaque réponse inclut un champ
`ccloudEquivalent` indiquant la commande `ccloud` exacte qui produirait le même résultat.
Cette implémentation reste la solution retenue pour le déploiement réel décrit ici — le
critère "au moins 2 outils CockroachDB" est rempli par le vector index + le MCP Cloud managé,
pas par ce contournement REST, qu'il ne faut donc pas présenter comme "ccloud CLI" au jury.

---

## Étape 1 — Prérequis AWS (compte réel, pour la démo)

### 1.1 Services AWS à activer
```
- ECR (Elastic Container Registry)     — image du conteneur API Server
- ECS Fargate                           — exécution du conteneur, sans serveur à gérer
- Application Load Balancer (ALB)       — expose l'API Server derrière /api
- S3                                    — bucket privé pour le build statique du dashboard
- CloudFront                            — CDN + routage /* → S3, /api/* → ALB, HTTPS géré
- ACM (us-east-1 pour CloudFront)       — certificat TLS
- Secrets Manager                       — tous les secrets (jamais en clair dans les task defs)
- CloudWatch + SNS                      — source d'alertes réelle pour déclencher l'agent
- IAM                                   — rôle de tâche ECS scoping ECS/RDS/Lambda en lecture+repair ciblé
- VPC                                   — VPC par défaut acceptable pour une démo
```

### 1.2 IAM — rôle de tâche ECS (`cloud-surgeon-task-role`)

Le rôle de tâche ne doit couvrir que ce que `artifacts/api-server/src/lib/aws.ts` appelle
réellement (ECS/RDS/Lambda repair) — **pas** `bedrock:InvokeModel`, puisque l'IA de cette
démo passe par l'API Anthropic directe (`ANTHROPIC_API_KEY`), Bedrock étant hors quota
actuellement (voir Étape 8).

```json
{
  "Effect": "Allow",
  "Action": [
    "ecs:UpdateService",
    "ecs:DescribeServices",
    "rds:ModifyDBInstance",
    "rds:DescribeDBInstances",
    "rds:RebootDBInstance",
    "lambda:PutFunctionConcurrency",
    "lambda:GetFunctionConcurrency",
    "cloudwatch:GetMetricData",
    "cloudwatch:DescribeAlarms"
  ],
  "Resource": "*"
}
```
Restreindre `Resource` aux ARNs des services de démo (pas `*`) avant un vrai passage en
production — acceptable pour une démo contrôlée, à ne pas présenter comme "production-ready"
tel quel devant le jury sans le dire.

---

## Étape 2 — Image Docker (API Server uniquement)

Le dashboard n'a plus besoin d'image Docker : c'est un artefact statique poussé sur S3.

`Dockerfile.api` à la racine :
```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/
RUN npm install -g pnpm && pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/artifacts/api-server/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
```
`dist/mcp/server.mjs` est inclus dans le même build (esbuild multi-entry) — le MCP tool
server tourne comme subprocess stdio du process principal, pas comme service séparé.

```bash
aws ecr create-repository --repository-name cloud-surgeon-api --region us-east-1

aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

docker build -f Dockerfile.api -t cloud-surgeon-api .
docker tag cloud-surgeon-api:latest \
  <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api:latest
docker push <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api:latest
```

---

## Étape 3 — Dashboard : build statique + S3

```bash
# Depuis la racine du monorepo — BASE_URL vide car il sera servi à la racine du domaine CloudFront
cd artifacts/dashboard
VITE_API_BASE_URL=https://<distribution>.cloudfront.net/api \
VITE_API_KEY=<CLOUD_SURGEON_API_KEY> \
VITE_DASHBOARD_PASSWORD=<mot_de_passe_démo> \
PORT=23183 BASE_PATH=/ pnpm run build

aws s3 mb s3://cloud-surgeon-dashboard-<suffixe-unique>
aws s3 sync dist/public/ s3://cloud-surgeon-dashboard-<suffixe-unique>/ --delete
```
Le bucket reste **privé** ; CloudFront y accède via Origin Access Control (OAC), pas d'accès
public direct au bucket.

---

## Étape 4 — Secrets (AWS Secrets Manager)

```bash
aws secretsmanager create-secret \
  --name cloud-surgeon/prod \
  --secret-string '{
    "COCKROACHDB_URL": "postgresql://user:pass@host:26257/cloud_surgeon?sslmode=verify-full",
    "CLOUD_SURGEON_API_KEY": "<openssl rand -hex 32>",
    "SESSION_SECRET": "<openssl rand -base64 32>",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "COCKROACH_CLOUD_API_KEY": "...",
    "COCKROACH_CLOUD_CLUSTER_ID": "..."
  }'
```
Secrets injectés en variables d'environnement dans la task definition ECS — jamais en clair
dans le code, les Dockerfiles, ou les logs.

---

## Étape 5 — Base de données (déjà provisionnée)

```bash
psql "$COCKROACHDB_URL&sslrootcert=system" \
  -f cloud-surgeon-agent/database/schema.sql
```
> `drizzle-kit push` ne fonctionne pas contre CockroachDB Serverless (divergences `VECTOR` /
> `sslrootcert`) — toujours appliquer `schema.sql` en SQL brut, idempotent, sûr à ré-exécuter.

Le CDC changefeed est créé automatiquement au démarrage de l'API Server et poste vers
`/api/internal/cdc`, qui doit rester accessible publiquement (pas de `X-API-Key`, CockroachDB
ne peut pas envoyer de header custom en webhook-https basique) — exposé via l'ALB, jamais via
CloudFront `/*` pour éviter toute confusion de routage avec le dashboard statique.

---

## Étape 6 — ECS Fargate (API Server uniquement)

```bash
aws ecs create-cluster --cluster-name cloud-surgeon --region us-east-1
```

Task definition :
```json
{
  "family": "cloud-surgeon-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT>:role/cloud-surgeon-task-role",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT>:role/ecsTaskExecutionRole",
  "containerDefinitions": [{
    "name": "api",
    "image": "<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api:latest",
    "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
    "environment": [
      { "name": "PORT", "value": "8080" },
      { "name": "NODE_ENV", "value": "production" },
      { "name": "AI_PROVIDER", "value": "anthropic" },
      { "name": "AWS_REGION", "value": "us-east-1" },
      { "name": "ECS_DEFAULT_CLUSTER", "value": "prod-cluster" },
      { "name": "CALIBRATION_THRESHOLD", "value": "0.15" }
    ],
    "secrets": [
      { "name": "COCKROACHDB_URL", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACHDB_URL::" },
      { "name": "CLOUD_SURGEON_API_KEY", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:CLOUD_SURGEON_API_KEY::" },
      { "name": "ANTHROPIC_API_KEY", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:ANTHROPIC_API_KEY::" },
      { "name": "COCKROACH_CLOUD_API_KEY", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACH_CLOUD_API_KEY::" },
      { "name": "COCKROACH_CLOUD_CLUSTER_ID", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACH_CLOUD_CLUSTER_ID::" },
      { "name": "SESSION_SECRET", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:SESSION_SECRET::" }
    ],
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:8080/api/healthz || exit 1"],
      "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30
    },
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/cloud-surgeon-api",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "api"
      }
    }
  }]
}
```

**AI_PROVIDER=anthropic, pas bedrock** : les quotas Bedrock sont actuellement désactivés
sur le compte de démo. `artifacts/api-server/src/lib/llm.ts` bascule automatiquement sur
l'API Anthropic directe (`ANTHROPIC_API_KEY`) quand `AI_PROVIDER=anthropic` — le code gère
déjà les deux chemins, il suffit de ne pas mettre de credentials Bedrock/`BEDROCK_API_KEY`
pour cette démo. Repasser à `AI_PROVIDER=bedrock` le jour où le quota est réactivé ne demande
aucun changement de code.

```bash
aws ecs create-service \
  --cluster cloud-surgeon \
  --service-name api \
  --task-definition cloud-surgeon-api \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:...:api-tg,containerName=api,containerPort=8080"
```

---

## Étape 7 — CloudFront (point d'entrée public unique)

```
Distribution CloudFront
  Origin 1: S3 (dashboard-<suffixe>)     — Origin Access Control, comportement par défaut /*
  Origin 2: ALB (cloud-surgeon-api)      — comportement /api/* (cache désactivé, forward tous headers)
  Certificat ACM (us-east-1)             — nom de domaine de la démo, ou domaine CloudFront par défaut
```

Security groups :
```
ALB Security Group:
  - Inbound: 443 depuis CloudFront (préfixe géré `com.amazonaws.global.cloudfront.origin-facing`)
API Task Security Group:
  - Inbound: 8080 depuis ALB Security Group uniquement
  - Outbound: 443 (CockroachDB Cloud API, cockroachlabs.cloud/mcp, api.anthropic.com)
  - Outbound: 26257 (CockroachDB Serverless SQL)
```

---

## Étape 8 — CloudWatch → SNS → Agent (ingestion réelle)

```bash
aws sns create-topic --name cloud-surgeon-alerts --region us-east-1

aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts \
  --protocol https \
  --notification-endpoint https://<distribution>.cloudfront.net/api/webhook/cloudwatch

aws cloudwatch put-metric-alarm \
  --alarm-name checkout-5xx-spike \
  --alarm-actions arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts \
  --metric-name 5XXError --namespace AWS/ApplicationELB \
  --statistic Sum --period 60 --threshold 10 \
  --comparison-operator GreaterThanThreshold --evaluation-periods 3
```

---

## Étape 9 — Variables d'environnement de référence (ECS task, API Server)

| Variable | Valeur démo | Source |
|---|---|---|
| `PORT` | `8080` | fixe |
| `NODE_ENV` | `production` | fixe |
| `AI_PROVIDER` | `anthropic` | fixe (Bedrock hors quota) |
| `ANTHROPIC_API_KEY` | — | Secrets Manager |
| `AWS_REGION` | `us-east-1` | fixe |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | rôle de tâche IAM (préféré aux clés statiques) |
| `COCKROACHDB_URL` | — | Secrets Manager |
| `CLOUD_SURGEON_API_KEY` | — | Secrets Manager |
| `SESSION_SECRET` | — | Secrets Manager |
| `COCKROACH_CLOUD_API_KEY` | — | Secrets Manager |
| `COCKROACH_CLOUD_CLUSTER_ID` | — | Secrets Manager |
| `ECS_DEFAULT_CLUSTER` | `prod-cluster` | fixe |
| `CALIBRATION_THRESHOLD` | `0.15` | fixe |

> Préférer le rôle de tâche IAM aux clés `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` statiques
> quand c'est possible — le SDK AWS les résout automatiquement depuis les credentials du rôle
> de tâche ECS sans qu'on ait besoin de les injecter en variable d'environnement du tout.

Dashboard (build-time uniquement — variables `VITE_*` inlinées, pas de runtime env) :
| Variable | Valeur démo |
|---|---|
| `VITE_API_BASE_URL` | `https://<distribution>.cloudfront.net/api` |
| `VITE_API_KEY` | valeur de `CLOUD_SURGEON_API_KEY` |
| `VITE_DASHBOARD_PASSWORD` | mot de passe de démo (Phase 1, voir `MIGRATION_REACT.md`) |

---

## Étape 10 — Checklist de mise en service

```
□ COCKROACH_CLOUD_API_KEY + COCKROACH_CLOUD_CLUSTER_ID renseignés → MCP Cloud managé LIVE
□ Schema CockroachDB appliqué (psql schema.sql)
□ Image Docker API Server buildée et poussée dans ECR
□ Secrets créés dans Secrets Manager (Anthropic, pas Bedrock)
□ Cluster ECS créé, service api démarré (1 tâche), health check vert
□ Build dashboard poussé sur S3, distribution CloudFront créée (OAC, pas d'accès public direct au bucket)
□ Comportement CloudFront /api/* → ALB validé
□ GET https://<distribution>.cloudfront.net/api/healthz → 200
□ Dashboard accessible à la racine du domaine CloudFront
□ SNS Topic créé et abonné au webhook CloudWatch
□ Test: déclenchement d'une alarme réelle → incident visible dans le dashboard
□ Test: crash chaos (`/api/chaos/sigkill`) → reprise sans perte d'état
```

---

## Coût estimé (démo, usage modéré)

| Service | Coût estimé |
|---|---|
| ECS Fargate 1 tâche (0.5 vCPU / 1 GB) | ~$10-15 / mois |
| ALB | ~$20 / mois |
| CloudFront + S3 | < $2 / mois (trafic de démo) |
| ECR stockage | < $1 / mois |
| CloudWatch logs | < $5 / mois |
| CockroachDB Serverless | Gratuit (free tier) |
| Anthropic API (Claude) | Pay-per-token |
| **Total** | **~$40-45 / mois** |

---

## Ce qui n'est PAS nécessaire

- ❌ Lambda — l'Express server fait tout, y compris le MCP tool server en subprocess
- ❌ API Gateway — CloudFront + ALB suffisent pour router HTTP
- ❌ RDS — CockroachDB Serverless est déjà dans le cloud
- ❌ ElastiCache — aucun état Redis requis
- ❌ ECS/Fargate pour le dashboard — c'est un artefact statique, S3 + CloudFront suffit et coûte moins cher
- ❌ Bedrock pour cette démo — quota désactivé ; `AI_PROVIDER=anthropic` couvre la même fonctionnalité sans changement de code

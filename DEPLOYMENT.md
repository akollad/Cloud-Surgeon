# Cloud-Surgeon — Plan de Déploiement AWS Complet

## Vue d'ensemble de l'architecture

```
Internet (HTTPS)
       │
       ▼
┌─────────────────────────────┐
│  Application Load Balancer  │  (ALB — un seul point d'entrée public)
│  https://cloud-surgeon.xyz  │
└──────────┬──────────────────┘
           │
     ┌─────┴──────────────────────────┐
     │                                │
     ▼                                ▼
/* → Streamlit (8501)         /api/* → Express (8080)
  ECS Fargate                       ECS Fargate
  cloud-surgeon-dashboard            cloud-surgeon-api
     │                                │
     └──────────────┬─────────────────┘
                    │ COCKROACHDB_URL
                    ▼
          CockroachDB Serverless
          (cloud.cockroachlabs.com)

AWS CloudWatch Alarm
       │
       ▼
   SNS Topic
       │ POST
       ▼
https://cloud-surgeon.xyz/api/webhook/cloudwatch
       │
       ▼
  Express (agent loop)
```

---

## Services à déployer

| Service | Technologie | Port | Hébergement |
|---|---|---|---|
| **API Server** (agent + REST) | Node.js 24 / Express 5 | 8080 | ECS Fargate |
| **Dashboard** | Python 3.11 / Streamlit | 8501 | ECS Fargate |
| **Base de données** | CockroachDB Serverless | 26257 | Cloud (déjà actif) |
| **MCP Server** | Node.js (subprocess) | stdio | Inclus dans API Server |

---

## Étape 1 — Prérequis AWS

### 1.1 Services AWS à activer
```
- ECS (Elastic Container Service)
- ECR (Elastic Container Registry)
- ALB (Application Load Balancer) via EC2
- ACM (AWS Certificate Manager) — certificat TLS pour ton domaine
- Secrets Manager — stockage des secrets
- CloudWatch — monitoring + alarmes
- SNS — webhook trigger
- IAM — rôles et permissions
- VPC — réseau (utiliser le VPC par défaut ou en créer un dédié)
```

### 1.2 IAM Role pour les tâches ECS
Créer un rôle `cloud-surgeon-task-role` avec les politiques :
```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "ecs:UpdateService",
    "ecs:DescribeServices",
    "rds:ModifyDBInstance",
    "rds:DescribeDBInstances",
    "lambda:PutFunctionConcurrency",
    "lambda:GetFunctionConcurrency",
    "cloudwatch:GetMetricStatistics"
  ],
  "Resource": "*"
}
```

---

## Étape 2 — Images Docker

### 2.1 Dockerfile — API Server
Créer `Dockerfile.api` à la racine :

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

### 2.2 Dockerfile — Dashboard
Créer `Dockerfile.dashboard` à la racine :

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY cloud-surgeon-agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY cloud-surgeon-agent/frontend/ ./frontend/
COPY cloud-surgeon-agent/.streamlit/ ./.streamlit/
ENV PYTHONUNBUFFERED=1
EXPOSE 8501
CMD ["python", "-m", "streamlit", "run", "frontend/app.py", \
     "--server.port=8501", "--server.address=0.0.0.0"]
```

### 2.3 Build et push vers ECR
```bash
# Configurer AWS CLI
aws configure  # ou utiliser les variables d'env

# Créer les repositories ECR
aws ecr create-repository --repository-name cloud-surgeon-api --region us-east-1
aws ecr create-repository --repository-name cloud-surgeon-dashboard --region us-east-1

# Authentification ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

# Build et push — API Server
docker build -f Dockerfile.api -t cloud-surgeon-api .
docker tag cloud-surgeon-api:latest \
  <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api:latest
docker push <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-api:latest

# Build et push — Dashboard
docker build -f Dockerfile.dashboard -t cloud-surgeon-dashboard .
docker tag cloud-surgeon-dashboard:latest \
  <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-dashboard:latest
docker push <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-dashboard:latest
```

---

## Étape 3 — Secrets (AWS Secrets Manager)

Créer un secret `cloud-surgeon/prod` avec toutes les valeurs :

```bash
aws secretsmanager create-secret \
  --name cloud-surgeon/prod \
  --secret-string '{
    "COCKROACHDB_URL": "postgresql://user:pass@host:26257/cloud_surgeon?sslmode=verify-full",
    "CLOUD_SURGEON_API_KEY": "<openssl rand -hex 32>",
    "SESSION_SECRET": "<openssl rand -base64 32>",
    "BEDROCK_API_KEY": "bdak-...",
    "COCKROACH_CLOUD_API_KEY": "...",
    "COCKROACH_CLOUD_CLUSTER_ID": "...",
    "VOYAGE_API_KEY": "..."
  }'
```

Les secrets sont injectés en variables d'environnement dans les task definitions ECS — **jamais en clair dans le code ou les Dockerfiles**.

---

## Étape 4 — Base de données

### 4.1 Appliquer le schéma (one-time)
```bash
# Depuis ta machine locale avec psql installé
psql "$COCKROACHDB_URL&sslrootcert=system" \
  -f cloud-surgeon-agent/database/schema.sql
```

### 4.2 Configurer le CDC Changefeed
Le changefeed est créé automatiquement au démarrage de l'API Server.
Il faut que l'URL `https://<alb-url>/api/internal/cdc` soit **publiquement accessible**
(pas derrière auth) pour que CockroachDB puisse y poster.

Le webhook `/api/internal/cdc` n'a intentionnellement **pas** de `X-API-Key` requis
(CockroachDB ne peut pas envoyer de headers custom en mode webhook-https basique).

---

## Étape 5 — ECS Fargate

### 5.1 Créer le cluster ECS
```bash
aws ecs create-cluster --cluster-name cloud-surgeon --region us-east-1
```

### 5.2 Task Definition — API Server
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
      { "name": "AI_PROVIDER", "value": "bedrock" },
      { "name": "BEDROCK_REGION", "value": "eu-west-1" },
      { "name": "AWS_REGION", "value": "us-east-1" },
      { "name": "DASHBOARD_ORIGIN", "value": "https://cloud-surgeon.xyz" }
    ],
    "secrets": [
      { "name": "COCKROACHDB_URL", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACHDB_URL::" },
      { "name": "CLOUD_SURGEON_API_KEY", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:CLOUD_SURGEON_API_KEY::" },
      { "name": "BEDROCK_API_KEY", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:BEDROCK_API_KEY::" },
      { "name": "COCKROACH_CLOUD_API_KEY", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACH_CLOUD_API_KEY::" },
      { "name": "COCKROACH_CLOUD_CLUSTER_ID", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:COCKROACH_CLOUD_CLUSTER_ID::" },
      { "name": "SESSION_SECRET", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:SESSION_SECRET::" }
    ],
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:8080/api/healthz || exit 1"],
      "interval": 30,
      "timeout": 5,
      "retries": 3,
      "startPeriod": 30
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

### 5.3 Task Definition — Dashboard
```json
{
  "family": "cloud-surgeon-dashboard",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT>:role/ecsTaskExecutionRole",
  "containerDefinitions": [{
    "name": "dashboard",
    "image": "<ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/cloud-surgeon-dashboard:latest",
    "portMappings": [{ "containerPort": 8501, "protocol": "tcp" }],
    "environment": [
      { "name": "API_BASE_URL", "value": "https://cloud-surgeon.xyz/api" },
      { "name": "DASHBOARD_PASSWORD", "value": "hackathon2026" }
    ],
    "secrets": [
      { "name": "CLOUD_SURGEON_API_KEY", "valueFrom": "arn:aws:secretsmanager:...:cloud-surgeon/prod:CLOUD_SURGEON_API_KEY::" }
    ],
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:8501/_stcore/health || exit 1"],
      "interval": 30,
      "timeout": 5,
      "retries": 3,
      "startPeriod": 60
    },
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/cloud-surgeon-dashboard",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "dashboard"
      }
    }
  }]
}
```

### 5.4 Créer les services ECS
```bash
# API Server — 1 instance minimum (stateless, peut scaler)
aws ecs create-service \
  --cluster cloud-surgeon \
  --service-name api \
  --task-definition cloud-surgeon-api \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:...:api-tg,containerName=api,containerPort=8080"

# Dashboard — 1 instance (Streamlit est stateful via session_state)
aws ecs create-service \
  --cluster cloud-surgeon \
  --service-name dashboard \
  --task-definition cloud-surgeon-dashboard \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:...:dashboard-tg,containerName=dashboard,containerPort=8501"
```

---

## Étape 6 — Application Load Balancer

### 6.1 Règles de routage
```
HTTPS :443
  ├── /api/*          → Target Group: cloud-surgeon-api    (port 8080)
  ├── /api/internal/* → Target Group: cloud-surgeon-api    (port 8080)  ← CDC webhook
  └── /*              → Target Group: cloud-surgeon-dashboard (port 8501)
```

### 6.2 Certificat TLS
Via ACM (gratuit pour les domaines AWS) :
```bash
aws acm request-certificate \
  --domain-name cloud-surgeon.xyz \
  --validation-method DNS
```

### 6.3 Security Groups
```
ALB Security Group:
  - Inbound: 443 from 0.0.0.0/0
  - Inbound: 80 from 0.0.0.0/0 (redirect → 443)

API Task Security Group:
  - Inbound: 8080 from ALB Security Group only
  - Outbound: 443 (CockroachDB, Bedrock, CRDB Cloud API)
  - Outbound: 26257 (CockroachDB Serverless)

Dashboard Task Security Group:
  - Inbound: 8501 from ALB Security Group only
  - Outbound: 443 (API via ALB)
```

---

## Étape 7 — CloudWatch → SNS → Agent

```bash
# 1. Créer le SNS Topic
aws sns create-topic --name cloud-surgeon-alerts --region us-east-1
# → retourne TopicArn: arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts

# 2. Abonner le webhook de l'API Server
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts \
  --protocol https \
  --notification-endpoint https://cloud-surgeon.xyz/api/webhook/cloudwatch
# L'API répond automatiquement au SubscriptionConfirmation → abonnement activé

# 3. Lier une alarme CloudWatch existante au topic
aws cloudwatch put-metric-alarm \
  --alarm-name checkout-5xx-spike \
  --alarm-actions arn:aws:sns:us-east-1:<ACCOUNT>:cloud-surgeon-alerts \
  --metric-name 5XXError \
  --namespace AWS/ApplicationELB \
  --statistic Sum \
  --period 60 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 3
```

---

## Étape 8 — Variables d'environnement de référence

### API Server (ECS task)
| Variable | Valeur prod |
|---|---|
| `PORT` | `8080` |
| `NODE_ENV` | `production` |
| `COCKROACHDB_URL` | depuis Secrets Manager |
| `CLOUD_SURGEON_API_KEY` | depuis Secrets Manager |
| `SESSION_SECRET` | depuis Secrets Manager |
| `AI_PROVIDER` | `bedrock` |
| `BEDROCK_API_KEY` | depuis Secrets Manager |
| `BEDROCK_REGION` | `eu-west-1` |
| `AWS_REGION` | `us-east-1` |
| `COCKROACH_CLOUD_API_KEY` | depuis Secrets Manager |
| `COCKROACH_CLOUD_CLUSTER_ID` | depuis Secrets Manager |
| `DASHBOARD_ORIGIN` | `https://cloud-surgeon.xyz` |
| `VOYAGE_API_KEY` | depuis Secrets Manager (optionnel) |
| `ECS_DEFAULT_CLUSTER` | `prod-cluster` |
| `CALIBRATION_THRESHOLD` | `0.15` |

### Dashboard (ECS task)
| Variable | Valeur prod |
|---|---|
| `API_BASE_URL` | `https://cloud-surgeon.xyz/api` |
| `CLOUD_SURGEON_API_KEY` | depuis Secrets Manager |
| `DASHBOARD_PASSWORD` | à définir |

---

## Étape 9 — Checklist de mise en service

```
□ Schema CockroachDB appliqué (psql schema.sql)
□ Images Docker buildées et pushées dans ECR
□ Secrets créés dans Secrets Manager
□ Cluster ECS créé
□ Task definitions enregistrées (API + Dashboard)
□ ALB créé avec les deux target groups
□ Règles de routage /api/* → api, /* → dashboard
□ Certificat TLS ACM validé et attaché à l'ALB
□ Security groups configurés
□ Services ECS démarrés (1 tâche chacun)
□ Health checks verts (ALB console → Target Groups)
□ GET https://cloud-surgeon.xyz/api/healthz → 200
□ Dashboard accessible https://cloud-surgeon.xyz
□ SNS Topic créé et abonné au webhook
□ Test webhook: bouton "📡 Simulate CloudWatch webhook" dans le dashboard
□ Test agent: "⚡ Trigger Agent" → incident RESOLVED visible
□ CDC Changefeed actif (badge 🟢 LIVE dans le dashboard)
```

---

## Coût estimé (hackathon — usage modéré)

| Service | Coût estimé |
|---|---|
| ECS Fargate 2 tâches (0.5 vCPU / 1 GB chacune) | ~$20-30 / mois |
| ALB | ~$20 / mois |
| ECR stockage | < $1 / mois |
| CloudWatch logs | < $5 / mois |
| CockroachDB Serverless | Gratuit (free tier) |
| Bedrock (Claude / Nova Pro) | Pay-per-token |
| **Total** | **~$45-60 / mois** |

---

## Ce qui n'est PAS nécessaire

- ❌ Lambda — l'Express server fait tout
- ❌ API Gateway — l'ALB suffit pour router HTTP
- ❌ RDS — CockroachDB Serverless est déjà dans le cloud
- ❌ ElastiCache — aucun état Redis requis
- ❌ S3 — aucun fichier statique à servir (Streamlit les embarque)

# Cloud-Surgeon — Agent DevOps Autonome Serverless

Agent IA autonome pour le Hackathon CockroachDB x AWS 2026. Détecte des alertes
d'infrastructure, diagnostique via RAG vectoriel (Amazon Bedrock Titan +
CockroachDB Vector Search), et répare via un agent Claude 3.5 Sonnet capable
de "tool calling". L'intégralité de l'état de l'agent vit dans CockroachDB,
jamais en mémoire vive Lambda — une invocation peut mourir à tout moment et
la suivante reprend exactement là où elle s'est arrêtée.

## Fichiers

- `schema.sql` — schéma CockroachDB (`incident_state`, `incident_vectors` avec
  index vectoriel, `execution_logs`).
- `lambda_function.py` — handler Lambda, connexion CockroachDB, embeddings
  Titan V2, recherche RAG cosinus, boucle d'agent Claude 3.5 Sonnet.
- `requirements.txt` — dépendances Python (`boto3`, `psycopg2-binary`).

## 1. Créer le cluster CockroachDB Serverless

1. Créer un compte sur [cockroachlabs.cloud](https://cockroachlabs.cloud) et
   provisionner un cluster **Serverless**.
2. Récupérer la chaîne de connexion (`Connect` → `Connection string`), format :
   ```
   postgresql://<user>:<password>@<host>:26257/<database>?sslmode=verify-full
   ```
3. Appliquer le schéma :
   ```bash
   psql "$DATABASE_URL" -f schema.sql
   ```
   (ou via le SQL shell intégré à la console CockroachDB Cloud).

## 2. Activer l'accès à Amazon Bedrock

1. Dans la console AWS, région où Bedrock est disponible (ex. `us-east-1`),
   activer l'accès aux modèles :
   - `anthropic.claude-3-5-sonnet-20240620-v1:0`
   - `amazon.titan-embed-text-v2:0`
   (Bedrock → Model access → Manage model access).
2. Aucune clé API à générer : la Lambda s'authentifie via son rôle IAM.

## 3. Préparer le package de déploiement Lambda

```bash
mkdir build && cp lambda_function.py build/
pip install -r requirements.txt -t build/
cd build && zip -r ../cloud-surgeon.zip . && cd ..
```

## 4. Créer la fonction Lambda

```bash
aws lambda create-function \
  --function-name cloud-surgeon \
  --runtime python3.11 \
  --handler lambda_function.lambda_handler \
  --timeout 60 \
  --memory-size 512 \
  --role arn:aws:iam::<ACCOUNT_ID>:role/cloud-surgeon-execution-role \
  --zip-file fileb://cloud-surgeon.zip \
  --environment "Variables={DATABASE_URL=<votre_connection_string_cockroachdb>,AWS_REGION=us-east-1}"
```

Le rôle IAM `cloud-surgeon-execution-role` doit inclure, au minimum, la
politique managée `AWSLambdaBasicExecutionRole` (logs CloudWatch) et une
politique custom autorisant :

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel"],
  "Resource": [
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0",
    "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0"
  ]
}
```

## 5. Variables d'environnement requises

| Variable              | Description                                              | Obligatoire |
| --------------------- | --------------------------------------------------------- | ----------- |
| `DATABASE_URL`        | Chaîne de connexion CockroachDB Serverless                | Oui         |
| `AWS_REGION`          | Région AWS pour Bedrock (défaut `us-east-1`)              | Non         |
| `CLAUDE_MODEL_ID`     | Override du modèle Claude (défaut Sonnet 3.5)             | Non         |
| `TITAN_EMBED_MODEL_ID`| Override du modèle Titan (défaut `amazon.titan-embed-text-v2:0`) | Non   |
| `MAX_AGENT_TURNS`     | Nombre max de tours de la boucle d'agent (défaut `8`)     | Non         |

Ne jamais committer `DATABASE_URL` en dur : la configurer via les variables
d'environnement Lambda (ou AWS Secrets Manager + résolution au cold start).

## 6. Tester

Invocation manuelle avec le CLI AWS :

```bash
aws lambda invoke \
  --function-name cloud-surgeon \
  --payload '{"alert_text": "ECS service checkout unhealthy: 5xx spike on /pay"}' \
  --cli-binary-format raw-in-base64-out \
  response.json
cat response.json
```

Pour valider la résilience : invoquer une seconde fois avec le **même**
`alert_text`. L'agent doit reconnaître le `alert_fingerprint` existant,
recharger `context_json` depuis `incident_state`, et reprendre (ou constater
que l'incident est déjà `RESOLVED`/`FAILED`) sans repartir de zéro.

## 7. Brancher une vraie alerte

En production, déclencher la Lambda via une alarme CloudWatch → SNS → Lambda,
ou EventBridge, en transformant le message d'alarme en `{"alert_text": "..."}`
avant l'invocation.

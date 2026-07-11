# Cloud-Surgeon — Agent DevOps Autonome Serverless

Agent IA autonome pour le Hackathon CockroachDB x AWS 2026. Détecte des alertes
d'infrastructure, diagnostique via RAG vectoriel (Amazon Bedrock Titan +
CockroachDB Vector Search), et répare via un agent Claude 3.5 Sonnet capable
de "tool calling". L'intégralité de l'état de l'agent vit dans CockroachDB,
jamais en mémoire vive Lambda — une invocation peut mourir à tout moment et
la suivante reprend exactement là où elle s'est arrêtée.

**Vidéo de démonstration (Devpost) :** _[à compléter avant soumission]_

## Structure du projet

```
cloud-surgeon-agent/
│
├── README.md               # Ce guide
├── requirements.txt         # Dépendances globales pour le développement local
│
├── database/
│   └── schema.sql            # incident_state, incident_vectors (+ index vectoriel), execution_logs
│
├── backend/                  # Le cœur de l'agent, déployé sur AWS Lambda
│   ├── lambda_function.py    # Handler Lambda : Bedrock (Claude 3.5 + Titan), RAG, tool calling
│   └── requirements.txt      # Dépendances à packager pour la Lambda
│
└── frontend/
    └── app.py                 # Dashboard Streamlit interactif pour simuler des pannes
```

## 1. Créer le cluster CockroachDB Serverless

1. Créer un compte sur [cockroachlabs.cloud](https://cockroachlabs.cloud) et
   provisionner un cluster **Serverless**.
2. Récupérer la chaîne de connexion (`Connect` → `Connection string`), format :
   ```
   postgresql://<user>:<password>@<host>:26257/<database>?sslmode=verify-full
   ```
3. Appliquer le schéma :
   ```bash
   psql "$COCKROACHDB_URL" -f database/schema.sql
   ```
   (ou via le SQL shell intégré à la console CockroachDB Cloud).

## 2. Activer l'accès à Amazon Bedrock (pour le backend Lambda)

1. Dans la console AWS, région où Bedrock est disponible (ex. `us-east-1`),
   activer l'accès aux modèles :
   - `anthropic.claude-3-5-sonnet-20240620-v1:0`
   - `amazon.titan-embed-text-v2:0`
   (Bedrock → Model access → Manage model access).
2. Aucune clé API à générer : la Lambda s'authentifie via son rôle IAM.

## 3. Déployer le backend sur AWS Lambda

```bash
mkdir build && cp backend/lambda_function.py build/
pip install -r backend/requirements.txt -t build/
cd build && zip -r ../cloud-surgeon.zip . && cd ..

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

### Variables d'environnement du backend Lambda

| Variable               | Description                                                       | Obligatoire |
| ---------------------- | ------------------------------------------------------------------ | ----------- |
| `DATABASE_URL`         | Chaîne de connexion CockroachDB Serverless                        | Oui         |
| `AWS_REGION`           | Région AWS pour Bedrock (défaut `us-east-1`)                      | Non         |
| `CLAUDE_MODEL_ID`      | Override du modèle Claude (défaut Sonnet 3.5)                     | Non         |
| `TITAN_EMBED_MODEL_ID` | Override du modèle Titan (défaut `amazon.titan-embed-text-v2:0`)  | Non         |
| `MAX_AGENT_TURNS`      | Nombre max de tours de la boucle d'agent (défaut `8`)              | Non         |

Ne jamais committer `DATABASE_URL` en dur : la configurer via les variables
d'environnement Lambda (ou AWS Secrets Manager + résolution au cold start).

### Tester le backend

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

En production, déclencher la Lambda via une alarme CloudWatch → SNS → Lambda,
ou EventBridge, en transformant le message d'alarme en `{"alert_text": "..."}`
avant l'invocation.

## 4. Lancer le dashboard de démonstration (frontend/app.py)

Le dashboard Streamlit permet de déclencher des pannes simulées et de
regarder l'agent les diagnostiquer/réparer en direct, sans dépendre de vraies
alertes CloudWatch.

```bash
pip install -r requirements.txt
export COCKROACHDB_URL="postgresql://<user>:<password>@<host>:26257/<database>?sslmode=verify-full"
streamlit run frontend/app.py --server.port 5000
```

- Si `COCKROACHDB_URL` est défini et que `database/schema.sql` a déjà été
  appliqué, le dashboard persiste réellement l'état des incidents, le
  journal d'exécution et la mémoire vectorielle RAG dans CockroachDB — utile
  pour prouver visuellement la résilience (bouton "Simuler un crash de la
  Lambda").
- Si `COCKROACHDB_URL` n'est pas défini, le dashboard bascule automatiquement
  en **mode simulation** (tout l'état vit dans la session Streamlit), pour
  pouvoir enregistrer une démo immédiatement sans configurer d'infrastructure.
- Le raisonnement de Claude et les résultats d'outils affichés dans le
  dashboard sont simulés localement (pas d'appel Bedrock réel depuis le
  frontend) afin de ne pas nécessiter de credentials AWS pour la démo ; le
  vrai raisonnement Bedrock a lieu côté `backend/lambda_function.py`.

## 5. Publier sur Devpost

1. Enregistrer une vidéo de démo montrant : déclenchement d'une panne →
   diagnostic RAG → réparation → résolution, puis la reprise après un crash
   simulé (bouton dédié dans le dashboard).
2. Ajouter le lien de la vidéo en haut de ce README.

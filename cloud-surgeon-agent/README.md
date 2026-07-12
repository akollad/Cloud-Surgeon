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
alertes CloudWatch. Il respecte le flux de communication du projet :

```
Frontend (Streamlit) --HTTP--> API Gateway / Backend (Lambda) --> Bedrock
                                                                --> CockroachDB
Frontend <--- rafraîchit en interrogeant l'état stocké en base ---
```

Le frontend **n'accède jamais directement à la base** : il envoie une
requête HTTP au backend, qui seul parle à Bedrock et à CockroachDB, puis
répond avec l'incident mis à jour. Le frontend rafraîchit ensuite ses
tableaux en interrogeant à nouveau le backend.

- **Sur AWS (production)** : le backend HTTP est une API Gateway devant la
  fonction `backend/lambda_function.py`, qui appelle réellement Bedrock
  (Claude 3.5 Sonnet + Titan) et lit/écrit dans CockroachDB Serverless.
  Pointer `frontend/app.py` dessus avec :
  ```bash
  export API_BASE_URL="https://<id-api-gateway>.execute-api.<region>.amazonaws.com"
  streamlit run frontend/app.py --server.port 5000
  ```
- **Dans ce Repl (démo)** : comme AWS Lambda/Bedrock ne sont pas disponibles
  ici, le rôle de "API Gateway + Lambda" est joué par le service API du
  monorepo (`artifacts/api-server`, routes `/api/incidents/*` et
  `/api/logs`, logique dans `artifacts/api-server/src/lib/cloud-surgeon.ts`).
  Ce service se connecte à un **vrai cluster CockroachDB Serverless**
  (secret `COCKROACHDB_URL`, voir `lib/db/src/index.ts`) — ce n'est pas un
  Postgres de substitution : les tables `incident_state`, `incident_vectors`
  (avec son `CREATE VECTOR INDEX` natif CockroachDB, pas une extension
  pgvector) et `execution_logs` vivent sur CockroachDB Cloud. Le raisonnement
  Claude et les outils sont simulés par un moteur déterministe (pas de
  credentials AWS nécessaires pour la démo), mais **toute la persistance
  d'état, la déduplication par empreinte, et la recherche RAG par similarité
  cosinus tournent contre CockroachDB réel**. C'est la configuration par
  défaut du workflow **Cloud-Surgeon Dashboard** de ce Repl (`API_BASE_URL`
  par défaut : `http://localhost:80/api`).
  - Le schéma est appliqué directement avec `psql "$COCKROACHDB_URL&sslrootcert=system" -f database/schema.sql`
    plutôt que `drizzle-kit push`, car l'introspection de `drizzle-kit push`
    n'est pas garantie compatible avec le dialecte CockroachDB (le SQL du
    fichier `schema.sql`, lui, est écrit et testé pour CockroachDB).

### Authentification, outils MCP, Bedrock réel

- **Authentification** : toutes les routes `/api/incidents/*` et `/api/logs`
  exigent un header `x-api-key` (secret partagé `CLOUD_SURGEON_API_KEY`,
  déjà envoyé automatiquement par le dashboard Streamlit). `/api/healthz`
  reste public. Voir `artifacts/api-server/src/middleware/apiKeyAuth.ts`.
- **Serveur MCP réel** : les outils `execute_ccloud_command` et
  `aws_repair_service` ne sont plus des fonctions appelées en dur — ils
  sont exposés par un vrai serveur MCP (`src/mcp/server.ts`, protocole
  standard Anthropic) lancé en sous-processus stdio, et appelés par
  l'agent via un client MCP (`src/mcp/client.ts`). N'importe quel autre
  client MCP (Claude Desktop, etc.) pourrait se connecter à ce même serveur.
- **Appel Bedrock réel** : le raisonnement ("thought") de chaque tour est
  généré par un vrai appel à Amazon Bedrock (Claude Haiku 4.5, via
  `src/lib/bedrock.ts`) quand `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
  sont configurées. **Dans cet environnement Replit, l'appel échoue
  actuellement avec une erreur géographique renvoyée par Anthropic**
  ("Access to Anthropic models is not allowed from unsupported countries,
  regions, or territories") — limitation de la région du datacenter, pas un
  bug côté agent. Chaque tour indique honnêtement sa source
  (`thoughtSource: "bedrock" | "simulated"`) : aucune simulation n'est
  jamais présentée comme un vrai appel réussi.
- **Appel CockroachDB Cloud API réel** : `execute_ccloud_command` interroge
  `GET /api/v1/clusters/{id}` avec `COCKROACH_CLOUD_API_KEY` /
  `COCKROACH_CLOUD_CLUSTER_ID`. Fonctionne en production — la clé de service
  account a un rôle (Cluster Admin/Read) assigné sur ce cluster dans la
  console CockroachDB Cloud. Chaque tour de diagnostic renvoie désormais le
  vrai état du cluster (`simulated: false`).
- **Action AWS reste volontairement simulée** : `aws_repair_service` n'exécute
  jamais de vraie action corrective (restart, scaling...) — un LLM qui
  déclenche automatiquement des actions destructives sur une vraie
  infrastructure sans garde-fou d'approbation humaine est un risque
  délibérément écarté de cette démo.
- **Vrai test de crash (SIGKILL)** : `scripts/real-crash-test.sh` déclenche un
  incident, attend l'écriture en base du 1er tour, puis tue *réellement* le
  process serveur (`kill -9`, pas un early return simulé dans le même appel
  HTTP). Après redémarrage du service, renvoyer la même alerte reprend
  l'agent exactement au tour suivant, sans dupliquer le tour déjà exécuté —
  validé manuellement le 12/07/2026. C'est la preuve de résilience à un vrai
  crash de process, complémentaire à l'option "simulate crash" du dashboard
  (qui reste un raccourci pédagogique in-process).

Pour lancer le dashboard seul en local :

```bash
pip install -r requirements.txt
streamlit run frontend/app.py --server.port 5000
```

Le bouton "Simuler un crash de la Lambda" envoie une requête qui arrête le
backend après le premier tour de raisonnement sans finaliser l'incident.
L'état déjà écrit en base survit ; cliquer de nouveau sur "Déclencher
l'agent" avec la même alerte envoie une nouvelle requête HTTP qui reprend
l'incident exactement où il s'était arrêté — la preuve de résilience que le
jury va chercher.

## 5. Publier sur Devpost

1. Enregistrer une vidéo de démo montrant : déclenchement d'une panne →
   diagnostic RAG → réparation → résolution, puis la reprise après un crash
   simulé (bouton dédié dans le dashboard).
2. Ajouter le lien de la vidéo en haut de ce README.

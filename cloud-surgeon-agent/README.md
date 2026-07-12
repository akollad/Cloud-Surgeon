# Cloud-Surgeon — Autonomous Serverless DevOps Agent

Autonomous AI agent for the CockroachDB x AWS 2026 Hackathon. Detects infrastructure
alerts, diagnoses via vector RAG (Amazon Bedrock Titan + CockroachDB Vector Search),
and repairs via a Claude 3.5 Sonnet agent capable of tool calling. The entire agent
state lives in CockroachDB, never in Lambda memory — an invocation can die at any
time and the next one resumes exactly where it left off.

**Demo video (Devpost):** _[to be added before submission]_

## Project structure

```
cloud-surgeon-agent/
│
├── README.md               # This guide
├── requirements.txt         # Global dependencies for local development
│
├── database/
│   └── schema.sql            # incident_state, incident_vectors (+ vector index), execution_logs
│
├── backend/                  # The agent core, deployed on AWS Lambda
│   ├── lambda_function.py    # Lambda handler: Bedrock (Claude 3.5 + Titan), RAG, tool calling
│   └── requirements.txt      # Dependencies to package for the Lambda
│
└── frontend/
    └── app.py                 # Interactive Streamlit dashboard to simulate failures
```

## 1. Create the CockroachDB Serverless cluster

1. Create an account on [cockroachlabs.cloud](https://cockroachlabs.cloud) and
   provision a **Serverless** cluster.
2. Retrieve the connection string (`Connect` → `Connection string`), format:
   ```
   postgresql://<user>:<password>@<host>:26257/<database>?sslmode=verify-full
   ```
3. Apply the schema:
   ```bash
   psql "$COCKROACHDB_URL" -f database/schema.sql
   ```
   (or via the SQL shell built into the CockroachDB Cloud console).

## 2. Enable Amazon Bedrock access (for the Lambda backend)

1. In the AWS console, in the region where Bedrock is available (e.g. `us-east-1`),
   enable access to the models:
   - `anthropic.claude-3-5-sonnet-20240620-v1:0`
   - `amazon.titan-embed-text-v2:0`
   (Bedrock → Model access → Manage model access).
2. No API key to generate: the Lambda authenticates via its IAM role.

## 3. Deploy the backend on AWS Lambda

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
  --environment "Variables={DATABASE_URL=<your_cockroachdb_connection_string>,AWS_REGION=us-east-1}"
```

The IAM role `cloud-surgeon-execution-role` must include, at minimum, the managed
policy `AWSLambdaBasicExecutionRole` (CloudWatch logs) and a custom policy allowing:

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

### Lambda backend environment variables

| Variable               | Description                                                       | Required    |
| ---------------------- | ------------------------------------------------------------------ | ----------- |
| `DATABASE_URL`         | CockroachDB Serverless connection string                          | Yes         |
| `AWS_REGION`           | AWS region for Bedrock (default `us-east-1`)                      | No          |
| `CLAUDE_MODEL_ID`      | Claude model override (default Sonnet 3.5)                        | No          |
| `TITAN_EMBED_MODEL_ID` | Titan model override (default `amazon.titan-embed-text-v2:0`)     | No          |
| `MAX_AGENT_TURNS`      | Max agent loop turns (default `8`)                                 | No          |

Never commit `DATABASE_URL` in plain text: configure it via Lambda environment
variables (or AWS Secrets Manager + cold-start resolution).

### Testing the backend

```bash
aws lambda invoke \
  --function-name cloud-surgeon \
  --payload '{"alert_text": "ECS service checkout unhealthy: 5xx spike on /pay"}' \
  --cli-binary-format raw-in-base64-out \
  response.json
cat response.json
```

To validate resilience: invoke a second time with the **same** `alert_text`.
The agent must recognize the existing `alert_fingerprint`, reload `context_json`
from `incident_state`, and resume (or confirm the incident is already
`RESOLVED`/`FAILED`) without starting over.

In production, trigger the Lambda via a CloudWatch alarm → SNS → Lambda,
or EventBridge, transforming the alarm message into `{"alert_text": "..."}`
before invocation.

## 4. Launch the demo dashboard (frontend/app.py)

The Streamlit dashboard lets you trigger simulated failures and watch the agent
diagnose/repair them live, without depending on real CloudWatch alerts. It follows
the project communication flow:

```
Frontend (Streamlit) --HTTP--> API Gateway / Backend (Lambda) --> Bedrock
                                                                --> CockroachDB
Frontend <--- refreshes by polling the state stored in the DB ---
```

The frontend **never talks directly to the database**: it sends an HTTP request
to the backend, which alone talks to Bedrock and CockroachDB, then responds with
the updated incident. The frontend then refreshes its views by querying the backend again.

- **On AWS (production)**: the HTTP backend is an API Gateway in front of the
  `backend/lambda_function.py` function, which actually calls Bedrock
  (Claude 3.5 Sonnet + Titan) and reads/writes to CockroachDB Serverless.
  Point `frontend/app.py` at it with:
  ```bash
  export API_BASE_URL="https://<api-gateway-id>.execute-api.<region>.amazonaws.com"
  streamlit run frontend/app.py --server.port 5000
  ```
- **In this Repl (demo)**: since AWS Lambda/Bedrock are not available here, the
  "API Gateway + Lambda" role is played by the monorepo API service
  (`artifacts/api-server`, routes `/api/incidents/*` and `/api/logs`, logic in
  `artifacts/api-server/src/lib/cloud-surgeon.ts`). This service connects to a
  **real CockroachDB Serverless cluster** (secret `COCKROACHDB_URL`, see
  `lib/db/src/index.ts`) — not a Postgres substitute: the tables `incident_state`,
  `incident_vectors` (with its native CockroachDB `CREATE VECTOR INDEX`, not a
  pgvector extension) and `execution_logs` live on CockroachDB Cloud. The Claude
  reasoning and tools are simulated by a deterministic engine (no AWS credentials
  needed for the demo), but **all state persistence, fingerprint-based deduplication,
  and cosine-similarity RAG search run against real CockroachDB**. This is the
  default configuration of the **Cloud-Surgeon Dashboard** workflow in this Repl
  (default `API_BASE_URL`: `http://localhost:80/api`).
  - The schema is applied directly with
    `psql "$COCKROACHDB_URL&sslrootcert=system" -f database/schema.sql`
    rather than `drizzle-kit push`, because `drizzle-kit push` introspection is
    not guaranteed to be compatible with the CockroachDB dialect (the SQL in
    `schema.sql` is written and tested for CockroachDB).

### Authentication, MCP tools, real Bedrock

- **Authentication**: all `/api/incidents/*` and `/api/logs` routes require an
  `x-api-key` header (shared secret `CLOUD_SURGEON_API_KEY`, sent automatically
  by the Streamlit dashboard). `/api/healthz` remains public. See
  `artifacts/api-server/src/middleware/apiKeyAuth.ts`.
- **Real MCP server**: the `execute_ccloud_command` and `aws_repair_service` tools
  are no longer hardcoded function calls — they are exposed by a real MCP server
  (`src/mcp/server.ts`, standard Anthropic protocol) launched as a stdio subprocess,
  and called by the agent via an MCP client (`src/mcp/client.ts`). Any other MCP
  client (Claude Desktop, etc.) could connect to this same server.
- **Real Bedrock call**: the reasoning ("thought") for each turn is generated by a
  real Amazon Bedrock call (Claude Haiku 4.5, via `src/lib/bedrock.ts`) when
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are configured. **In this Replit
  environment, the call currently fails with a geographic error from Anthropic**
  ("Access to Anthropic models is not allowed from unsupported countries, regions,
  or territories") — a datacenter region limitation, not an agent-side bug. Each
  turn honestly reports its source (`thoughtSource: "bedrock" | "simulated"`): no
  simulation is ever presented as a successful real call.
- **Real CockroachDB Cloud API call**: `execute_ccloud_command` queries
  `GET /api/v1/clusters/{id}` with `COCKROACH_CLOUD_API_KEY` /
  `COCKROACH_CLOUD_CLUSTER_ID`. Works in production — the service account key has
  a role (Cluster Admin/Read) assigned on this cluster in the CockroachDB Cloud
  console. Each diagnostic turn now returns the actual cluster state (`simulated: false`).
- **AWS action intentionally simulated**: `aws_repair_service` never executes a
  real corrective action (restart, scaling...) — an LLM that automatically triggers
  destructive actions on real infrastructure without a human approval guardrail is a
  risk deliberately excluded from this demo.
- **Real crash test (SIGKILL)**: `scripts/real-crash-test.sh` triggers an incident,
  waits for the first turn to be written to the DB, then *actually* kills the server
  process (`kill -9`, not a simulated early return within the same HTTP call). After
  restarting the service, sending the same alert resumes the agent exactly at the
  next turn, without duplicating the already-executed turn — validated manually on
  2026-07-12. This proves resilience against a real process crash, complementing
  the "simulate crash" option in the dashboard (which remains an in-process
  pedagogical shortcut).

To launch the dashboard alone locally:

```bash
pip install -r requirements.txt
streamlit run frontend/app.py --server.port 5000
```

The "Simulate Lambda crash" button sends a request that stops the backend after the
first reasoning turn without finalizing the incident. The state already written to
the DB survives; clicking "Trigger agent" again with the same alert sends a new HTTP
request that resumes the incident exactly where it stopped — the resilience proof
judges will look for.

## 5. Publish on Devpost

1. Record a demo video showing: triggering a failure → RAG diagnosis → repair →
   resolution, then resumption after a simulated crash (dedicated button in the dashboard).
2. Add the video link at the top of this README.

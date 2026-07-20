Project Structure
cloud-surgeon/
├── README.md                          ← you are here
├── LICENSE                            ← MIT
├── .env.example                       ← environment variable template
├── pnpm-workspace.yaml                ← pnpm monorepo config
│
├── artifacts/
│   ├── api-server/                    ← Express 5 + TypeScript API server
│   │   └── src/
│   │       ├── index.ts               ← entry point; startup DDL init
│   │       ├── app.ts                 ← Express app; middleware; rate limiting
│   │       ├── lib/
│   │       │   ├── cloud-surgeon.ts   ← 3-phase agent loop (1 000+ lines)
│   │       │   ├── aws.ts             ← ECS / RDS / Lambda repair
│   │       │   ├── llm.ts             ← LLM dispatcher (AI_PROVIDER router: mistral / bedrock / anthropic)
│   │       │   ├── bedrock-mantle.ts  ← Mistral Large 3 via bedrock-mantle (OpenAI-compat, Bearer token)
│   │       │   ├── bedrock.ts         ← Amazon Nova Lite via Bedrock Converse API (fallback)
│   │       │   ├── anomaly.ts         ← predictive anomaly detection
│   │       │   ├── cdc.ts             ← CockroachDB changefeed + SSE (CDC_WEBHOOK_URL in prod)
│   │       │   ├── crdbMcp.ts         ← official CockroachDB Cloud MCP client
│   │       │   ├── embeddings.ts      ← Voyage AI / hash fallback embeddings
│   │       │   ├── prompt-guard.ts    ← injection sanitizer (length / patterns)
│   │       │   └── seed.ts            ← vector memory seeder
│   │       ├── mcp/
│   │       │   ├── server.ts          ← MCP tool server (stdio)
│   │       │   └── client.ts          ← MCP client (spawns server subprocess)
│   │       └── routes/
│   │           ├── incidents.ts       ← incident CRUD + approve/reject/correct
│   │           ├── metrics.ts         ← win-rates, MTTR, calibration, ccloud REST
│   │           ├── stream.ts          ← SSE audit stream + CDC webhook receiver
│   │           ├── webhook.ts         ← CloudWatch/SNS alert ingestion (auto-confirms SNS)
│   │           └── chaos.ts           ← chaos engineering endpoints
│   │
│   └── dashboard/                     ← React 19 + Vite SPA
│       └── src/
│           ├── pages/                 ← live, decisions, incidents, memory,
│           │                            calibration, impact, logs, guide
│           └── components/            ← shared UI (shadcn/ui + Tailwind)
│
├── cloud-surgeon-agent/
│   └── database/
│       └── schema.sql                 ← canonical CockroachDB DDL (source of truth)
│
├── lib/
│   ├── db/src/schema/                 ← Drizzle schema definitions (query builder)
│   └── api-zod/src/generated/api.ts   ← Zod types for API contract
│
├── Dockerfile.api                     ← multi-stage Docker build for the API Server
├── DEPLOYMENT.md                      ← full AWS deployment guide (ECR/ECS/CloudFront/SNS)
└── scripts/
    └── post-merge.sh                  ← post-merge setup (pnpm install + build)
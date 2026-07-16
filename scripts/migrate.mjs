/**
 * Hand-written DDL migration for CockroachDB Serverless.
 * drizzle-kit push is not used because CockroachDB has subtle DDL differences.
 * Run: node scripts/migrate.mjs
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pg = require("/home/runner/workspace/node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

const { Client } = pg;

if (!process.env.COCKROACHDB_URL) {
  console.error("COCKROACHDB_URL is not set");
  process.exit(1);
}

const client = new Client({ connectionString: process.env.COCKROACHDB_URL });
await client.connect();
console.log("Connected to CockroachDB");

const statements = [
  // conversations (used by integrations-anthropic-ai)
  `CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // messages
  `CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // incident_state — core resilience table
  `CREATE TABLE IF NOT EXISTS incident_state (
    incident_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_fingerprint VARCHAR(255) NOT NULL UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'TRIGGERED',
    current_step VARCHAR(100),
    context_json JSONB NOT NULL DEFAULT '{}',
    claimed_by_agent VARCHAR(50),
    caused_by_incident_id UUID,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    ru_consumed INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // incident_vectors — RAG knowledge base with 1024-dim vectors
  `CREATE TABLE IF NOT EXISTS incident_vectors (
    vector_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID REFERENCES incident_state(incident_id),
    error_message_text TEXT NOT NULL,
    embedding VECTOR(1024) NOT NULL,
    strategy_name VARCHAR(100) NOT NULL DEFAULT 'default_repair',
    outcome_success BOOLEAN NOT NULL DEFAULT true,
    signal_source VARCHAR(10) NOT NULL DEFAULT 'outcome',
    weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // agent_handoffs — multi-agent coordination log
  `CREATE TABLE IF NOT EXISTS agent_handoffs (
    handoff_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incident_state(incident_id),
    agent_name VARCHAR(50) NOT NULL,
    decision_mode VARCHAR(50),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // execution_logs — immutable action journal
  `CREATE TABLE IF NOT EXISTS execution_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES incident_state(incident_id),
    action_taken TEXT NOT NULL,
    result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // strategy_calibration — self-correcting contextual bandit
  `CREATE TABLE IF NOT EXISTS strategy_calibration (
    strategy_name VARCHAR(100) PRIMARY KEY,
    avg_predicted_win_rate DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    observed_win_rate DOUBLE PRECISION,
    correction_factor DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    prediction_count INTEGER NOT NULL DEFAULT 0,
    human_signal_count INTEGER NOT NULL DEFAULT 0,
    last_recalculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // metric_snapshots — proactive anomaly detection
  `CREATE TABLE IF NOT EXISTS metric_snapshots (
    snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metric_name VARCHAR(255) NOT NULL,
    service_name VARCHAR(255) NOT NULL,
    metric_value DOUBLE PRECISION NOT NULL,
    metric_text TEXT NOT NULL,
    embedding VECTOR(1024) NOT NULL,
    matched_incident_id UUID REFERENCES incident_state(incident_id),
    similarity_score DOUBLE PRECISION,
    predictive_incident_id UUID REFERENCES incident_state(incident_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // playbooks — AI-generated repair runbooks
  `CREATE TABLE IF NOT EXISTS playbooks (
    playbook_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL UNIQUE REFERENCES incident_state(incident_id),
    strategy_name VARCHAR(100) NOT NULL,
    title TEXT NOT NULL,
    content_md TEXT NOT NULL,
    generated_by VARCHAR(50) NOT NULL DEFAULT 'cloud-surgeon',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // rollback_plans — pre-repair state snapshots
  `CREATE TABLE IF NOT EXISTS rollback_plans (
    rollback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL UNIQUE REFERENCES incident_state(incident_id),
    strategy_name VARCHAR(100) NOT NULL,
    pre_repair_state JSONB NOT NULL DEFAULT '{}',
    executed_commands TEXT NOT NULL DEFAULT '',
    rollback_steps TEXT NOT NULL DEFAULT '',
    estimated_rollback_time VARCHAR(50),
    risk_level VARCHAR(20) NOT NULL DEFAULT 'low',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // Vector index for RAG similarity search
  `CREATE INDEX IF NOT EXISTS idx_incident_vectors_embedding
    ON incident_vectors USING ivfflat (embedding vector_cosine_ops)`,

  // Vector index for anomaly detection
  `CREATE INDEX IF NOT EXISTS idx_metric_snapshots_embedding
    ON metric_snapshots USING ivfflat (embedding vector_cosine_ops)`,
];

let ok = 0;
let failed = 0;
for (const sql of statements) {
  const preview = sql.trim().split("\n")[0].slice(0, 60);
  try {
    await client.query(sql);
    console.log(`  ✓ ${preview}`);
    ok++;
  } catch (err) {
    // ivfflat is Postgres-only; CockroachDB uses its own ANN index syntax — skip gracefully
    if (err.message?.includes("ivfflat") || err.message?.includes("access method")) {
      console.log(`  ~ ${preview} (skipped — CockroachDB uses native ANN index)`);
    } else {
      console.error(`  ✗ ${preview}\n    ${err.message}`);
      failed++;
    }
  }
}

await client.end();
console.log(`\nMigration complete: ${ok} succeeded, ${failed} failed`);
if (failed > 0) process.exit(1);

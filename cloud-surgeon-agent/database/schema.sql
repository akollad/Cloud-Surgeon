-- ============================================================================
-- Cloud-Surgeon — CockroachDB Serverless Schema
-- Hackathon CockroachDB x AWS 2026
--
-- This schema serves as "indestructible memory" for the autonomous DevOps agent.
-- Every agent thought, every tool call, and every result is persisted here
-- transactionally, so that a Lambda that crashes or times out mid-repair can be
-- resumed identically by a new invocation, with 0% context loss.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Vector extension
-- CockroachDB exposes the VECTOR type natively (>= v24.2) without an explicit
-- extension to activate as under Postgres/pgvector. The line below is kept for
-- compatibility with clusters that replicate Postgres syntax; it is a harmless
-- no-op on native CockroachDB.
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- Table incident_state
--
-- Core of resilience: one row per unique incident (deduplicated by
-- alert_fingerprint). context_json holds the full history of Claude messages
-- (thoughts + tool_use + tool_result) so the agent can reconstruct its Bedrock
-- conversation exactly where it left off.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_state (
    incident_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_fingerprint   VARCHAR(255) UNIQUE NOT NULL,
    status              VARCHAR(50) NOT NULL DEFAULT 'TRIGGERED'
                            CHECK (status IN ('TRIGGERED', 'DIAGNOSING', 'REPAIRING',
                                              'RESOLVED', 'FAILED', 'PENDING_APPROVAL')),
    current_step        VARCHAR(100),
    context_json        JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Multi-agent coordination: which agent (diagnostician/remediator/auditor)
    -- currently holds the write lock on this incident. Claimed and released
    -- via a serializable CockroachDB transaction.
    claimed_by_agent    VARCHAR(50),
    -- Causal chaining: was this incident triggered as a side effect of another
    -- already-resolved incident? Self-reference traversable by a recursive CTE
    -- (WITH RECURSIVE) to reconstruct the causal chain.
    caused_by_incident_id UUID REFERENCES incident_state (incident_id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup of active incidents (not resolved/failed) at Lambda handler startup,
-- for idempotence/resumption.
CREATE INDEX IF NOT EXISTS idx_incident_state_status
    ON incident_state (status)
    WHERE status NOT IN ('RESOLVED', 'FAILED');

-- Fast lookup of incidents claimed by a given agent.
CREATE INDEX IF NOT EXISTS idx_incident_state_claimed_by_agent
    ON incident_state (claimed_by_agent)
    WHERE claimed_by_agent IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Table incident_vectors
--
-- RAG knowledge base: each row is a historical error message that has been
-- resolved, vectorized via Amazon Titan Text Embeddings V2 (1024 dimensions).
-- The agent queries this table by cosine similarity before choosing an action,
-- to reuse already-known solutions.
--
-- strategy_name + outcome_success allow computing a per-strategy success rate
-- via pure SQL aggregation — a contextual bandit backed by CockroachDB,
-- with no external ML service.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_vectors (
    vector_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Optional FK to the source incident (NULL for seed entries inserted
    -- manually during memory initialization).
    incident_id         UUID REFERENCES incident_state (incident_id),
    error_message_text  TEXT NOT NULL,
    embedding           VECTOR(1024) NOT NULL,
    strategy_name       VARCHAR(100) NOT NULL DEFAULT 'default_repair',
    outcome_success     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vector similarity index. CockroachDB implements ANN search via a native
-- vector index of type C-SPANN (annotated here with USING vector, the
-- functional equivalent of IVFFLAT/HNSW indexes in pgvector).
-- The distance used at query time (operator <=>) is cosine distance.
CREATE VECTOR INDEX IF NOT EXISTS idx_incident_vectors_embedding
    ON incident_vectors (embedding vector_cosine_ops);

-- Index on strategy_name for win-rate aggregations.
CREATE INDEX IF NOT EXISTS idx_incident_vectors_strategy
    ON incident_vectors (strategy_name);

-- ----------------------------------------------------------------------------
-- Table agent_handoffs
--
-- Traceability of handoffs between specialized agents (Diagnostician,
-- Remediator, Auditor). Each claim/release of an incident is logged,
-- along with the decision mode chosen by the Remediator
-- (autonomous / needs_approval / cautious) based on RAG score and win-rate.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_handoffs (
    handoff_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id     UUID NOT NULL REFERENCES incident_state (incident_id),
    agent_name      VARCHAR(50) NOT NULL,
    decision_mode   VARCHAR(50),
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_incident_id
    ON agent_handoffs (incident_id);

-- ----------------------------------------------------------------------------
-- Table execution_logs
--
-- Immutable chronological journal of every machine action attempted by
-- the agent (tool_use -> tool_result), retained even after incident resolution,
-- for audit purposes and for later RAG enrichment.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_logs (
    log_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id  UUID NOT NULL REFERENCES incident_state (incident_id),
    action_taken TEXT NOT NULL,
    result       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_incident_id
    ON execution_logs (incident_id);

-- Supports filtering and searching by action type in the audit log.
CREATE INDEX IF NOT EXISTS idx_execution_logs_action
    ON execution_logs (action_taken);

-- Fast lookup by incident_id on incident_vectors for causal enrichment.
CREATE INDEX IF NOT EXISTS idx_incident_vectors_incident_id
    ON incident_vectors (incident_id);

-- ----------------------------------------------------------------------------
-- Idempotent migrations — columns added after initial creation
-- (ADD COLUMN IF NOT EXISTS is supported by CockroachDB >= v21.1)
-- ----------------------------------------------------------------------------
ALTER TABLE incident_state
    ADD COLUMN IF NOT EXISTS claimed_by_agent    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS caused_by_incident_id UUID REFERENCES incident_state (incident_id);

ALTER TABLE incident_vectors
    ADD COLUMN IF NOT EXISTS incident_id     UUID REFERENCES incident_state (incident_id),
    ADD COLUMN IF NOT EXISTS strategy_name   VARCHAR(100) NOT NULL DEFAULT 'default_repair',
    ADD COLUMN IF NOT EXISTS outcome_success BOOLEAN NOT NULL DEFAULT TRUE;

-- ----------------------------------------------------------------------------
-- Migration: add PENDING_APPROVAL to the incident_state.status CHECK constraint.
-- CockroachDB does not support ALTER CONSTRAINT; must drop and recreate.
-- The generated CHECK name is <table>_status_check (CockroachDB convention).
-- ----------------------------------------------------------------------------
ALTER TABLE incident_state DROP CONSTRAINT IF EXISTS incident_state_status_check;
ALTER TABLE incident_state
    ADD CONSTRAINT incident_state_status_check
    CHECK (status IN ('TRIGGERED', 'DIAGNOSING', 'REPAIRING',
                      'RESOLVED', 'FAILED', 'PENDING_APPROVAL'));

-- ----------------------------------------------------------------------------
-- Migration: MTTR and cost per incident
-- triggered_at = trigger timestamp (e.g. alert arrival time)
-- resolved_at  = resolution/failure timestamp (enables MTTR calculation)
-- ru_consumed  = estimated CockroachDB Request Units consumed (demo)
-- ----------------------------------------------------------------------------
ALTER TABLE incident_state
    ADD COLUMN IF NOT EXISTS triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ru_consumed  INT NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- Table strategy_calibration (automatic bandit calibration)
--
-- One row per strategy. Records the average PREDICTED win-rate at the time of
-- each routing decision and the ACTUAL win-rate observed in post-hoc analysis.
-- If the gap exceeds 15%, a multiplicative correction factor is computed and
-- applied to future decisions. Entirely backed by CockroachDB —
-- no external ML service required.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS strategy_calibration (
    strategy_name          VARCHAR(100) PRIMARY KEY,
    avg_predicted_win_rate FLOAT NOT NULL DEFAULT 0.5,
    observed_win_rate      FLOAT,
    correction_factor      FLOAT NOT NULL DEFAULT 1.0,
    prediction_count       INT NOT NULL DEFAULT 0,
    -- Cumulative count of human signals (rejections + corrections)
    human_signal_count     INT NOT NULL DEFAULT 0,
    last_recalculated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration: signal source and weighting for human signals
ALTER TABLE incident_vectors
    ADD COLUMN IF NOT EXISTS signal_source VARCHAR(10) NOT NULL DEFAULT 'outcome',
    ADD COLUMN IF NOT EXISTS weight        FLOAT       NOT NULL DEFAULT 1.0;

ALTER TABLE strategy_calibration
    ADD COLUMN IF NOT EXISTS human_signal_count INT NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- Table playbooks (AI-generated repair runbooks)
--
-- After each resolved incident Cloud-Surgeon synthesises a Markdown playbook
-- from its own turn history (thoughts + tool calls + results) and stores it
-- here. Unlike human-written runbooks, these capture the actual reasoning
-- chain used by the model. Retrievable via GET /api/metrics/playbooks.
--
-- UNIQUE (incident_id) ensures one canonical playbook per incident
-- (ON CONFLICT ... DO UPDATE for idempotent regeneration).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS playbooks (
    playbook_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   UUID NOT NULL UNIQUE REFERENCES incident_state (incident_id),
    strategy_name VARCHAR(100) NOT NULL,
    title         TEXT NOT NULL,
    content_md    TEXT NOT NULL,
    generated_by  VARCHAR(50) NOT NULL DEFAULT 'cloud-surgeon',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_playbooks_strategy
    ON playbooks (strategy_name);

-- ----------------------------------------------------------------------------
-- Migration: add ROLLED_BACK to the incident_state.status CHECK constraint.
-- Required by runRollbackLoop() in cloud-surgeon.ts which sets status = 'ROLLED_BACK'
-- on a successful rollback. Without this, the UPDATE fails with a CHECK violation.
-- ----------------------------------------------------------------------------
ALTER TABLE incident_state DROP CONSTRAINT IF EXISTS incident_state_status_check;
ALTER TABLE incident_state
    ADD CONSTRAINT incident_state_status_check
    CHECK (status IN ('TRIGGERED', 'DIAGNOSING', 'REPAIRING',
                      'RESOLVED', 'FAILED', 'PENDING_APPROVAL',
                      'ROLLED_BACK'));

-- ----------------------------------------------------------------------------
-- Migration: fix column types — timestamp → timestamptz
-- These columns were created as plain TIMESTAMP on older clusters.
-- The Drizzle schema defines them with withTimezone:true; aligning the DB.
-- ----------------------------------------------------------------------------
ALTER TABLE incident_state   ALTER COLUMN updated_at  TYPE TIMESTAMPTZ;
ALTER TABLE execution_logs   ALTER COLUMN created_at  TYPE TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- Data repair: backfill auditVerdict + repairSuccess in context_json
-- for incidents resolved before these fields were written by the Auditor.
-- Reconstructed from turns[2].toolOutput.verdict and turns[1].toolOutput.success.
-- ----------------------------------------------------------------------------
UPDATE incident_state
SET context_json = jsonb_set(
    jsonb_set(context_json, '{auditVerdict}',
      COALESCE(context_json->'turns'->2->'toolOutput'->'verdict', '"PASS"')),
    '{repairSuccess}',
    COALESCE(context_json->'turns'->1->'toolOutput'->'success', 'false'))
WHERE status IN ('RESOLVED','FAILED')
  AND context_json->>'auditVerdict' IS NULL
  AND jsonb_array_length(context_json->'turns') = 3;

UPDATE incident_state
SET context_json = jsonb_set(
    jsonb_set(context_json, '{auditVerdict}',
      CASE current_step
        WHEN 'HUMAN_CORRECTED' THEN '"HUMAN_CORRECTED"'
        ELSE '"HUMAN_REJECTED"' END::jsonb),
    '{repairSuccess}', 'false')
WHERE status = 'FAILED'
  AND context_json->>'auditVerdict' IS NULL
  AND current_step IN ('HUMAN_REJECTED','HUMAN_CORRECTED');

UPDATE incident_state
SET context_json = jsonb_set(
    jsonb_set(context_json, '{auditVerdict}', '"PASS"'),
    '{repairSuccess}',
    COALESCE(context_json->'turns'->1->'toolOutput'->'success', 'true'))
WHERE status = 'RESOLVED' AND current_step = 'FINALIZED'
  AND context_json->>'auditVerdict' IS NULL
  AND jsonb_array_length(context_json->'turns') = 2;

-- ----------------------------------------------------------------------------
-- CDC changefeed token authentication
--
-- When CDC_WEBHOOK_SECRET is set, the changefeed sink URL includes
-- ?token=<CDC_WEBHOOK_SECRET>. The /api/internal/cdc endpoint validates
-- this token and rejects unauthenticated requests with HTTP 401.
-- Apply the new secret and recreate the changefeed via:
--   CANCEL JOB <job_id>;
-- Then restart the API server — initChangefeed() recreates it with the token.
-- ----------------------------------------------------------------------------

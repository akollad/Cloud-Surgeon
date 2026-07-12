-- ============================================================================
-- Cloud-Surgeon — Schéma CockroachDB Serverless
-- Hackathon CockroachDB x AWS 2026
--
-- Ce schéma sert de "mémoire indestructible" pour l'agent DevOps autonome.
-- Toute pensée de l'agent, tout appel d'outil, et tout résultat est persisté
-- ici de façon transactionnelle, afin qu'une Lambda qui crash ou expire au
-- milieu d'une réparation puisse être reprise à l'identique par une nouvelle
-- invocation, avec 0% de perte de contexte.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extension vectorielle
-- CockroachDB expose nativement le type VECTOR (>= v24.2) sans extension à
-- activer explicitement comme sous Postgres/pgvector. La ligne ci-dessous est
-- conservée pour compatibilité avec des clusters qui répliquent la syntaxe
-- Postgres ; elle est un no-op inoffensif sur CockroachDB natif.
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ----------------------------------------------------------------------------
-- Table incident_state
--
-- Cœur de la résilience : une ligne par incident unique (déduplication par
-- alert_fingerprint). context_json contient l'historique complet des
-- messages Claude (pensées + tool_use + tool_result) afin que l'agent puisse
-- reconstruire sa conversation Bedrock exactement où elle s'est arrêtée.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_state (
    incident_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_fingerprint   VARCHAR(255) UNIQUE NOT NULL,
    status              VARCHAR(50) NOT NULL DEFAULT 'TRIGGERED'
                            CHECK (status IN ('TRIGGERED', 'DIAGNOSING', 'REPAIRING',
                                              'RESOLVED', 'FAILED', 'PENDING_APPROVAL')),
    current_step        VARCHAR(100),
    context_json        JSONB NOT NULL DEFAULT '{}'::JSONB,
    -- Coordination multi-agents : quel agent (diagnostician/remediator/auditor)
    -- détient actuellement le droit d'écrire sur cet incident. Réclamé et
    -- libéré via une transaction sérialisable CockroachDB.
    claimed_by_agent    VARCHAR(50),
    -- Chaînage causal : cet incident a-t-il été déclenché en réaction à un
    -- autre incident déjà résolu ? Auto-référence traversable par une CTE
    -- récursive (WITH RECURSIVE) pour reconstruire la chaîne causale.
    caused_by_incident_id UUID REFERENCES incident_state (incident_id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recherche rapide des incidents actifs (non résolus/échoués) au démarrage
-- du handler Lambda, pour l'idempotence/reprise.
CREATE INDEX IF NOT EXISTS idx_incident_state_status
    ON incident_state (status)
    WHERE status NOT IN ('RESOLVED', 'FAILED');

-- Recherche rapide des incidents réclamés par un agent donné.
CREATE INDEX IF NOT EXISTS idx_incident_state_claimed_by_agent
    ON incident_state (claimed_by_agent)
    WHERE claimed_by_agent IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Table incident_vectors
--
-- Base de connaissance RAG : chaque ligne est un message d'erreur historique
-- déjà résolu, vectorisé via Amazon Titan Text Embeddings V2 (dimension 1024).
-- L'agent interroge cette table par similarité cosinus avant de choisir une
-- action, pour réutiliser les solutions déjà connues.
--
-- strategy_name + outcome_success permettent de calculer un taux de succès
-- par stratégie via une agrégation SQL pure — un bandit contextuel appuyé
-- sur CockroachDB, sans service ML externe.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_vectors (
    vector_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- FK optionnelle vers l'incident source (NULL pour les entrées seed
    -- insérées manuellement lors de l'initialisation de la mémoire).
    incident_id         UUID REFERENCES incident_state (incident_id),
    error_message_text  TEXT NOT NULL,
    embedding           VECTOR(1024) NOT NULL,
    strategy_name       VARCHAR(100) NOT NULL DEFAULT 'default_repair',
    outcome_success     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index de similarité vectorielle. CockroachDB implémente la recherche ANN
-- via un index vectoriel natif de type C-SPANN (annoté ici avec USING
-- vector, l'équivalent fonctionnel des index IVFFLAT/HNSW de pgvector).
-- La distance utilisée à la requête (opérateur <=>) est la distance cosinus.
CREATE VECTOR INDEX IF NOT EXISTS idx_incident_vectors_embedding
    ON incident_vectors (embedding vector_cosine_ops);

-- Index sur strategy_name pour les agrégations de win-rate.
CREATE INDEX IF NOT EXISTS idx_incident_vectors_strategy
    ON incident_vectors (strategy_name);

-- ----------------------------------------------------------------------------
-- Table agent_handoffs
--
-- Traçabilité des passations entre agents spécialisés (Diagnostician,
-- Remediator, Auditor). Chaque réclamation/libération d'un incident est
-- journalisée, avec le mode de décision retenu par le Remediator
-- (autonomous / needs_approval / cautious) selon le score RAG et le win-rate.
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
-- Journal chronologique immuable de chaque action machine tentée par
-- l'agent (tool_use -> tool_result), conservé même après résolution de
-- l'incident, pour audit et pour enrichir le RAG plus tard.
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

-- ----------------------------------------------------------------------------
-- Migrations idempotentes — colonnes ajoutées après la création initiale
-- (ADD COLUMN IF NOT EXISTS est supporté par CockroachDB >= v21.1)
-- ----------------------------------------------------------------------------
ALTER TABLE incident_state
    ADD COLUMN IF NOT EXISTS claimed_by_agent    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS caused_by_incident_id UUID REFERENCES incident_state (incident_id);

ALTER TABLE incident_vectors
    ADD COLUMN IF NOT EXISTS incident_id     UUID REFERENCES incident_state (incident_id),
    ADD COLUMN IF NOT EXISTS strategy_name   VARCHAR(100) NOT NULL DEFAULT 'default_repair',
    ADD COLUMN IF NOT EXISTS outcome_success BOOLEAN NOT NULL DEFAULT TRUE;

-- ----------------------------------------------------------------------------
-- Migration : ajout de PENDING_APPROVAL au CHECK de incident_state.status
-- CockroachDB ne supporte pas ALTER CONSTRAINT ; on doit supprimer et recréer.
-- Le nom du CHECK généré est <table>_status_check (convention CockroachDB).
-- ----------------------------------------------------------------------------
ALTER TABLE incident_state DROP CONSTRAINT IF EXISTS incident_state_status_check;
ALTER TABLE incident_state
    ADD CONSTRAINT incident_state_status_check
    CHECK (status IN ('TRIGGERED', 'DIAGNOSING', 'REPAIRING',
                      'RESOLVED', 'FAILED', 'PENDING_APPROVAL'));

-- ----------------------------------------------------------------------------
-- Migration : MTTR et coût par incident
-- triggered_at = timestamp de déclenchement (ex: arrivée de l'alerte)
-- resolved_at  = timestamp de résolution/échec (permet de calculer le MTTR)
-- ru_consumed  = estimation des Request Units CockroachDB consommées (demo)
-- ----------------------------------------------------------------------------
ALTER TABLE incident_state
    ADD COLUMN IF NOT EXISTS triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ru_consumed  INT NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- Table strategy_calibration (Tâche 8 — calibration automatique du bandit)
--
-- Une ligne par stratégie. Enregistre le win-rate moyen PRÉDIT au moment
-- de chaque décision de routage et le win-rate RÉEL observé en post-hoc.
-- Si l'écart dépasse 15%, un facteur de correction multiplicatif est calculé
-- et appliqué aux décisions futures. Entièrement porté par CockroachDB —
-- aucun service ML externe requis.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS strategy_calibration (
    strategy_name          VARCHAR(100) PRIMARY KEY,
    avg_predicted_win_rate FLOAT NOT NULL DEFAULT 0.5,
    observed_win_rate      FLOAT,
    correction_factor      FLOAT NOT NULL DEFAULT 1.0,
    prediction_count       INT NOT NULL DEFAULT 0,
    -- Tâche 9 : nombre cumulé de signaux humains (rejets + corrections)
    human_signal_count     INT NOT NULL DEFAULT 0,
    last_recalculated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration Tâche 9 : signal source et pondération des signaux humains
ALTER TABLE incident_vectors
    ADD COLUMN IF NOT EXISTS signal_source VARCHAR(10) NOT NULL DEFAULT 'outcome',
    ADD COLUMN IF NOT EXISTS weight        FLOAT       NOT NULL DEFAULT 1.0;

ALTER TABLE strategy_calibration
    ADD COLUMN IF NOT EXISTS human_signal_count INT NOT NULL DEFAULT 0;

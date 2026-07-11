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
    incident_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_fingerprint VARCHAR(255) UNIQUE NOT NULL,
    status            VARCHAR(50) NOT NULL DEFAULT 'TRIGGERED'
                          CHECK (status IN ('TRIGGERED', 'DIAGNOSING', 'REPAIRING', 'RESOLVED', 'FAILED')),
    current_step      VARCHAR(100),
    context_json      JSONB NOT NULL DEFAULT '{}'::JSONB,
    updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- Recherche rapide des incidents actifs (non résolus/échoués) au démarrage
-- du handler Lambda, pour l'idempotence/reprise.
CREATE INDEX IF NOT EXISTS idx_incident_state_status
    ON incident_state (status)
    WHERE status NOT IN ('RESOLVED', 'FAILED');

-- ----------------------------------------------------------------------------
-- Table incident_vectors
--
-- Base de connaissance RAG : chaque ligne est un message d'erreur historique
-- déjà résolu, vectorisé via Amazon Titan Text Embeddings V2 (dimension 1024).
-- L'agent interroge cette table par similarité cosinus avant de choisir une
-- action, pour réutiliser les solutions déjà connues.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_vectors (
    vector_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    error_message_text TEXT NOT NULL,
    embedding          VECTOR(1024) NOT NULL,
    created_at         TIMESTAMP NOT NULL DEFAULT now()
);

-- Index de similarité vectorielle. CockroachDB implémente la recherche ANN
-- via un index vectoriel natif de type C-SPANN (annoté ici avec USING
-- vector, l'équivalent fonctionnel des index IVFFLAT/HNSW de pgvector).
-- La distance utilisée à la requête (opérateur <=>) est la distance cosinus.
CREATE VECTOR INDEX IF NOT EXISTS idx_incident_vectors_embedding
    ON incident_vectors (embedding vector_cosine_ops);

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
    created_at   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_incident_id
    ON execution_logs (incident_id);

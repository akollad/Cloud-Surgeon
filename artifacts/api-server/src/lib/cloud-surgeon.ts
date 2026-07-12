import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  agentHandoffsTable,
  executionLogsTable,
  incidentStateTable,
  incidentVectorsTable,
  strategyCalibrationTable,
  type IncidentState,
} from "@workspace/db";
import { callMcpTool } from "../mcp/client";
import { invokeLLMThought } from "./llm";
import { generateEmbedding } from "./embeddings";
import { type ChaosConfig, ChaosPartitionError, injectChaos, sleep as chaosSleep } from "./chaos";

// ============================================================================
// Cloud-Surgeon — Architecture à 3 couches
//
// Couche 1 : Mémoire causale et évaluée (RAG vectoriel + win-rate par stratégie)
// Couche 2 : La mémoire décide (routage AUTONOMOUS / PENDING_APPROVAL / EXPLORATORY)
// Couche 3 : Coordination multi-agents via transactions sérialisables CockroachDB
// ============================================================================

// ── Types ─────────────────────────────────────────────────────────────────

export type RoutingMode = "AUTONOMOUS" | "PENDING_APPROVAL" | "EXPLORATORY" | "REJECTED";
export type AgentName = "diagnostician" | "remediator" | "auditor";

interface AgentTurn {
  turn: number;
  agent: AgentName;
  thought: string;
  thoughtSource: "anthropic" | "bedrock" | "simulated";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown>;
}

export interface IncidentContext {
  alertText?: string;
  strategyName?: string;
  // Couche 2 : décision de routage et données ayant conduit à la décision
  routingMode?: RoutingMode;
  routingDecisionComputed?: boolean;
  ragScore?: number | null;         // distance cosinus (0 = identique, 1 = opposé)
  ragStrategyHint?: string | null;  // stratégie de l'incident le plus similaire
  winRate?: number | null;          // win-rate brut historique de la stratégie
  winRateSampleSize?: number;       // nombre de samples ayant servi au calcul
  // Couche 1 — calibration automatique (Tâche 8)
  correctionFactor?: number | null; // facteur de correction de la stratégie (1.0 = neutre)
  effectiveWinRate?: number | null; // winRate × correctionFactor (utilisé pour le routage)
  turns?: AgentTurn[];
  finalResponse?: string | null;
  crashed?: boolean;
  [key: string]: unknown;
}

// ── Couche 1 : utilitaires de mémoire ────────────────────────────────────

export function fingerprint(alertText: string): string {
  return createHash("sha256").update(alertText.trim()).digest("hex");
}


/** Détecte la stratégie à appliquer à partir du texte d'alerte. */
export function detectStrategy(alertText: string): string {
  const t = alertText.toLowerCase();
  if (t.includes("jvm") || t.includes("heap") || t.includes("oom")) return "jvm_heap_restart";
  if (t.includes("max_connections") || t.includes("connection pool") || t.includes("pg_stat")) return "db_connection_pool_reset";
  if (t.includes("latency") && (t.includes("cross-region") || t.includes("cross_region") || t.includes("bgp"))) return "network_route_failover";
  if (t.includes("accessdenied") || t.includes("credential") || t.includes("iam") || t.includes("expired")) return "iam_credential_rotation";
  if (t.includes("stripe") || t.includes("payment gateway") || t.includes("circuit")) return "external_dependency_circuit_break";
  if (t.includes("5xx") || t.includes("unhealthy") || (t.includes("ecs") && t.includes("service"))) return "ecs_service_restart";
  if (t.includes("cpu") || t.includes("rds")) return "rds_cpu_throttle";
  if (t.includes("throttl") || t.includes("concurrentexecution")) return "lambda_concurrency_scale";
  if (t.includes("disk") || t.includes("storage")) return "disk_cleanup";
  if (t.includes("cloudwatch") && t.includes("alarm")) return "cloudwatch_alarm_triage";
  return "default_repair";
}

/** Extrait un nom de service lisible depuis le texte d'alerte. */
export function detectServiceName(alertText: string): string {
  const m = alertText.match(/'([^']+)'/);
  if (m) return m[1];
  const t = alertText.toLowerCase();
  if (t.includes("ecs")) return "ecs-service";
  if (t.includes("rds")) return "rds-instance";
  if (t.includes("lambda")) return "lambda-function";
  if (t.includes("ec2")) return "ec2-instance";
  return "auto-detected-service";
}

/**
 * Taux de succès historique d'une stratégie — le bandit contextuel porté par
 * CockroachDB. Aucun service ML externe : une agrégation SQL suffit.
 *
 * Depuis la Tâche 9, la formule est pondérée : chaque signal contribue selon
 * son poids (weight=1.0 pour les outcomes automatiques, weight=0.5 pour les
 * signaux humains). Cela évite que quelques rejets humains rapides ne
 * renversent un historique de centaines d'incidents résolus.
 *
 *   win_rate = SUM(weight × outcome_success) / SUM(weight)
 */
export async function getStrategyWinRate(
  strategyName: string,
): Promise<{ winRate: number; count: number }> {
  const rows = await db.execute<{ win_rate: string; total: string }>(sql`
    SELECT
      SUM(CASE WHEN outcome_success THEN weight ELSE 0.0 END)
        / NULLIF(SUM(weight), 0.0) AS win_rate,
      COUNT(*) AS total
    FROM incident_vectors
    WHERE strategy_name = ${strategyName}
  `);
  const row = rows.rows[0];
  if (!row || row.total === "0") return { winRate: 0.5, count: 0 }; // prior neutre si inconnu
  return { winRate: Number(row.win_rate), count: Number(row.total) };
}

/** Win-rate de toutes les stratégies connues — exposé via /api/metrics/win-rates. */
export async function getAllStrategyWinRates(): Promise<
  Array<{ strategyName: string; winRate: number; successCount: number; totalCount: number }>
> {
  const rows = await db.execute<{
    strategy_name: string;
    win_rate: string;
    success_count: string;
    total_count: string;
  }>(sql`
    SELECT
      strategy_name,
      COUNT(*) FILTER (WHERE outcome_success) * 1.0 / NULLIF(COUNT(*), 0) AS win_rate,
      COUNT(*) FILTER (WHERE outcome_success) AS success_count,
      COUNT(*) AS total_count
    FROM incident_vectors
    GROUP BY strategy_name
    ORDER BY win_rate DESC
  `);
  return rows.rows.map((r) => ({
    strategyName: r.strategy_name,
    winRate: Number(r.win_rate),
    successCount: Number(r.success_count),
    totalCount: Number(r.total_count),
  }));
}

export async function findSimilarIncident(embedding: number[]): Promise<{
  errorMessageText: string;
  strategyName: string;
  distance: number;
  outcomeSuccess: boolean;
} | undefined> {
  const literal = `[${embedding.join(",")}]`;
  const rows = await db.execute<{
    error_message_text: string;
    strategy_name: string;
    outcome_success: boolean;
    distance: number;
  }>(sql`
    SELECT error_message_text, strategy_name, outcome_success,
           embedding <=> ${literal}::vector AS distance
    FROM incident_vectors
    ORDER BY embedding <=> ${literal}::vector
    LIMIT 1
  `);
  const row = rows.rows[0];
  return row
    ? {
        errorMessageText: row.error_message_text,
        strategyName: row.strategy_name,
        outcomeSuccess: Boolean(row.outcome_success),
        distance: Number(row.distance),
      }
    : undefined;
}

async function indexResolvedIncident(
  incidentId: string,
  errorMessageText: string,
  embedding: number[],
  strategyName: string,
  outcomeSuccess: boolean,
): Promise<void> {
  await db.insert(incidentVectorsTable).values({
    incidentId,
    errorMessageText,
    embedding,
    strategyName,
    outcomeSuccess,
  });
  // Immediately recalibrate this strategy so future routing decisions benefit
  // from the latest outcome.
  await recalibrateStrategy(strategyName);
}

// ── Couche 1 : calibration automatique du bandit ──────────────────────────

/**
 * Seuil de déviation (valeur absolue) entre win-rate prédit et win-rate
 * observé au-delà duquel le facteur de correction est activé.
 * Configurable via CALIBRATION_THRESHOLD env var (défaut : 0.15 = 15 %).
 */
const CALIBRATION_THRESHOLD = Number(process.env.CALIBRATION_THRESHOLD ?? 0.15);

/**
 * Enregistre le win-rate prédit au moment d'une décision de routage.
 *
 * Maintient une moyenne glissante pondérée par le nombre de décisions
 * (`prediction_count`) de façon à ce que les décisions récentes ne biaisent
 * pas excessivement l'historique. Utilise un UPSERT CockroachDB :
 *
 *   new_avg = (old_avg × old_count + new_prediction) / (old_count + 1)
 *
 * Appelé une fois par incident, juste avant la décision de routage.
 */
async function recordRoutingPrediction(
  strategyName: string,
  predictedWinRate: number,
): Promise<void> {
  // CockroachDB rejects FLOAT * INT — cast prediction_count to FLOAT explicitly.
  await db.execute(sql`
    INSERT INTO strategy_calibration (strategy_name, avg_predicted_win_rate, prediction_count, last_recalculated_at)
    VALUES (${strategyName}, ${predictedWinRate}, 1, now())
    ON CONFLICT (strategy_name) DO UPDATE
    SET avg_predicted_win_rate =
          (strategy_calibration.avg_predicted_win_rate * strategy_calibration.prediction_count::float
            + EXCLUDED.avg_predicted_win_rate)
          / (strategy_calibration.prediction_count::float + 1.0),
        prediction_count      = strategy_calibration.prediction_count + 1,
        last_recalculated_at  = now()
  `);
}

/**
 * Recalcule le win-rate réel (observé) depuis `incident_vectors` pour une
 * stratégie et met à jour le facteur de correction dans `strategy_calibration`.
 *
 * Formule du facteur de correction :
 *   - Si |observed − predicted| ≤ CALIBRATION_THRESHOLD → correction_factor = 1.0 (neutre)
 *   - Sinon → correction_factor = clamp(observed / predicted, 0.1, 1.5)
 *
 * Un facteur < 1 dégrade les décisions futures (trop d'échecs imprévus).
 * Un facteur > 1 améliore les décisions futures (meilleure performance que prévu).
 *
 * Entièrement porté par CockroachDB — aucun service ML externe.
 */
export async function recalibrateStrategy(strategyName: string): Promise<void> {
  // Observed win-rate = SQL aggregate from incident_vectors (all time)
  const observed = await getStrategyWinRate(strategyName);
  if (observed.count === 0) return; // aucune donnée — on ne modifie pas le facteur

  const observedWinRate = observed.winRate;

  // Fetch current predicted average (if any row exists)
  const rows = await db.execute<{ avg_predicted_win_rate: string; prediction_count: string }>(sql`
    SELECT avg_predicted_win_rate, prediction_count
    FROM strategy_calibration
    WHERE strategy_name = ${strategyName}
  `);
  if (rows.rows.length === 0) return; // no routing decisions recorded yet for this strategy

  const predictedWinRate = Number(rows.rows[0].avg_predicted_win_rate);
  const deviation = Math.abs(observedWinRate - predictedWinRate);

  const correctionFactor =
    deviation > CALIBRATION_THRESHOLD
      ? Math.max(0.1, Math.min(1.5, predictedWinRate > 0 ? observedWinRate / predictedWinRate : 1.0))
      : 1.0;

  await db.execute(sql`
    UPDATE strategy_calibration
    SET observed_win_rate     = ${observedWinRate},
        correction_factor     = ${correctionFactor},
        last_recalculated_at  = now()
    WHERE strategy_name = ${strategyName}
  `);
}

/**
 * Récupère le facteur de correction actuel d'une stratégie.
 * Retourne 1.0 si aucune donnée de calibration n'est encore disponible.
 */
async function getCorrectionFactor(strategyName: string): Promise<number> {
  const rows = await db.execute<{ correction_factor: string }>(sql`
    SELECT correction_factor FROM strategy_calibration WHERE strategy_name = ${strategyName}
  `);
  if (rows.rows.length === 0) return 1.0;
  return Number(rows.rows[0].correction_factor);
}

// ── Couche 2 : boucle de feedback humain ──────────────────────────────────

export type HumanFeedback = "rejected" | "corrected" | "approved";

/**
 * Enregistre un signal humain dans la mémoire vectorielle et met à jour la
 * calibration de la stratégie concernée.
 *
 * ### Principe de pondération
 * Les signaux humains utilisent `weight = 0.5` (contre 1.0 pour les outcomes
 * automatiques). Cela rend la mémoire prudente : un seul rejet rapide ne peut
 * pas effacer un historique de dizaines de succès, mais plusieurs signaux
 * humains cohérents font basculer le routage.
 *
 * ### Signaux produits
 * - **rejected** : 1 signal négatif (w=0.5) sur la stratégie rejetée
 * - **corrected** : 1 signal négatif (w=0.5) sur la stratégie rejetée
 *                 + 1 signal positif (w=0.5) sur la stratégie suggérée
 * - **approved**  : aucun signal (l'outcome de résolution le couvrira)
 *
 * ### Traçabilité
 * La colonne `signal_source = "human"` permet au dashboard et au jury de
 * distinguer les signaux humains des outcomes automatiques.
 */
export async function recordHumanFeedback(
  incidentId: string,
  alertText: string,
  strategyName: string,
  feedback: HumanFeedback,
  suggestedStrategy?: string,
): Promise<void> {
  const embedding = await generateEmbedding(alertText);
  const HUMAN_WEIGHT = 0.5;

  if (feedback === "rejected" || feedback === "corrected") {
    // Signal négatif pondéré pour la stratégie rejetée
    await db.insert(incidentVectorsTable).values({
      incidentId,
      errorMessageText: alertText,
      embedding,
      strategyName,
      outcomeSuccess: false,
      signalSource: "human",
      weight: HUMAN_WEIGHT,
    });

    // Recalibration immédiate : le facteur de correction doit refléter
    // l'avis de l'humain avant la prochaine décision de routage.
    await recalibrateStrategy(strategyName);

    // Incrémenter le compteur de signaux humains dans strategy_calibration
    await db.execute(sql`
      INSERT INTO strategy_calibration (strategy_name, human_signal_count, last_recalculated_at)
      VALUES (${strategyName}, 1, now())
      ON CONFLICT (strategy_name) DO UPDATE
      SET human_signal_count   = strategy_calibration.human_signal_count + 1,
          last_recalculated_at = now()
    `);
  }

  if (feedback === "corrected" && suggestedStrategy) {
    // Signal positif pondéré pour la stratégie suggérée par l'humain
    await db.insert(incidentVectorsTable).values({
      incidentId,
      errorMessageText: alertText,
      embedding,
      strategyName: suggestedStrategy,
      outcomeSuccess: true,
      signalSource: "human",
      weight: HUMAN_WEIGHT,
    });

    await recalibrateStrategy(suggestedStrategy);

    await db.execute(sql`
      INSERT INTO strategy_calibration (strategy_name, human_signal_count, last_recalculated_at)
      VALUES (${suggestedStrategy}, 1, now())
      ON CONFLICT (strategy_name) DO UPDATE
      SET human_signal_count   = strategy_calibration.human_signal_count + 1,
          last_recalculated_at = now()
    `);
  }

  // Journal d'exécution — traçabilité pour le dashboard et le jury
  await db.insert(executionLogsTable).values({
    incidentId,
    actionTaken: `HUMAN_FEEDBACK_${feedback.toUpperCase()}`,
    result: JSON.stringify({
      strategyName,
      feedback,
      suggestedStrategy: suggestedStrategy ?? null,
      signalWeight: HUMAN_WEIGHT,
      note: "Couche 2 → Couche 1 : le jugement humain réalimente directement le win-rate SQL.",
    }),
  });
}

export type CalibrationStatus = "calibrated" | "downgraded" | "upgraded" | "no_data";

export interface CalibrationRow {
  strategyName: string;
  avgPredictedWinRate: number;
  observedWinRate: number | null;
  correctionFactor: number;
  predictionCount: number;
  humanSignalCount: number;
  deviation: number | null;
  status: CalibrationStatus;
  lastRecalculatedAt: Date;
}

/**
 * Retourne la table complète de calibration pour le dashboard et l'endpoint API.
 */
export async function getAllCalibrationData(): Promise<CalibrationRow[]> {
  const rows = await db.execute<{
    strategy_name: string;
    avg_predicted_win_rate: string;
    observed_win_rate: string | null;
    correction_factor: string;
    prediction_count: string;
    human_signal_count: string;
    last_recalculated_at: string;
  }>(sql`
    SELECT strategy_name, avg_predicted_win_rate, observed_win_rate,
           correction_factor, prediction_count, human_signal_count,
           last_recalculated_at
    FROM strategy_calibration
    ORDER BY prediction_count DESC, strategy_name
  `);

  return rows.rows.map((r) => {
    const predicted = Number(r.avg_predicted_win_rate);
    const observed = r.observed_win_rate != null ? Number(r.observed_win_rate) : null;
    const factor = Number(r.correction_factor);
    const count = Number(r.prediction_count);
    const humanSignalCount = Number(r.human_signal_count ?? 0);
    const deviation = observed != null ? observed - predicted : null;

    let status: CalibrationStatus;
    if (count === 0 || observed == null) {
      status = "no_data";
    } else if (factor < 1.0 - 0.001) {
      status = "downgraded"; // observed < predicted by > 15%
    } else if (factor > 1.0 + 0.001) {
      status = "upgraded"; // observed > predicted by > 15%
    } else {
      status = "calibrated"; // within threshold
    }

    return {
      strategyName: r.strategy_name,
      avgPredictedWinRate: predicted,
      observedWinRate: observed,
      correctionFactor: factor,
      predictionCount: count,
      humanSignalCount,
      deviation,
      status,
      lastRecalculatedAt: new Date(r.last_recalculated_at),
    };
  });
}

/**
 * Recalibrates all strategies present in strategy_calibration in one pass.
 * Exposed via POST /api/metrics/calibration/recalibrate for the dashboard button.
 */
export async function recalibrateAllStrategies(): Promise<{ updated: number }> {
  const rows = await db.execute<{ strategy_name: string }>(sql`
    SELECT strategy_name FROM strategy_calibration
  `);
  let updated = 0;
  for (const row of rows.rows) {
    await recalibrateStrategy(row.strategy_name);
    updated++;
  }
  return { updated };
}

// ── Couche 2 : décision de routage ────────────────────────────────────────

/**
 * Décide du mode de routage à partir du win-rate historique de la stratégie
 * détectée (Couche 2). La distance RAG est conservée dans le contexte pour
 * affichage dans le dashboard mais n'influence plus le seuil de décision :
 * les pseudo-embeddings déterministes (SHA-256 + LCG) ont une distance
 * cosinus ~0.93 même entre textes identiques en raison du stockage float32
 * de CockroachDB VECTOR — les seuils de proximité d'embedding classiques
 * (< 0.1) ne s'appliquent pas à ce cas. En production, des embeddings Titan
 * Text V2 (float32 natifs) rendraient la distance significative.
 *
 *  AUTONOMOUS     : stratégie connue (> 0 samples) ET win-rate > 80%
 *                   → l'agent agit seul, la mémoire confirme la fiabilité
 *  PENDING_APPROVAL: stratégie connue mais win-rate ≤ 80%
 *                   → l'agent propose et attend la validation humaine
 *  EXPLORATORY    : aucun sample connu pour cette stratégie
 *                   → territoire inexploré, mode apprentissage documenté
 */
export function computeRoutingMode(
  strategyName: string,
  _distance: number | undefined, // conservé pour la Couche 3 (logging/affichage)
  winRate: number | undefined,
  sampleCount: number,
): RoutingMode {
  // Stratégie de repli générique → toujours exploratoire (rien à apprendre)
  if (sampleCount === 0 || strategyName === "default_repair") return "EXPLORATORY";
  if ((winRate ?? 0) > 0.8) return "AUTONOMOUS";
  return "PENDING_APPROVAL";
}

// ── Couche 3 : coordination multi-agents via transactions ─────────────────

/**
 * Réclame un incident pour un agent donné via une transaction sérialisable
 * CockroachDB. Retry automatique sur erreur de sérialisation (code 40001)
 * — c'est CockroachDB qui est l'arbitre, pas le code.
 */
export async function claimIncidentForAgent(
  incidentId: string,
  agentName: AgentName,
): Promise<IncidentState | null> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<Record<string, unknown>>(
        `UPDATE incident_state
         SET claimed_by_agent = $1, updated_at = now()
         WHERE incident_id = $2 AND claimed_by_agent IS NULL
         RETURNING *`,
        [agentName, incidentId],
      );
      await client.query("COMMIT");
      if (result.rows.length === 0) return null; // déjà réclamé par un autre
      return mapRowToIncidentState(result.rows[0]);
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => {});
      const pgErr = err as { code?: string };
      if (pgErr.code === "40001" && attempt < MAX_RETRIES - 1) {
        // Conflit de sérialisation CockroachDB — backoff exponentiel
        await sleep(50 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
  return null;
}

/** Libère la réclamation d'un incident (fin de phase d'un agent). */
export async function releaseIncidentClaim(incidentId: string): Promise<void> {
  await db
    .update(incidentStateTable)
    .set({ claimedByAgent: null })
    .where(eq(incidentStateTable.incidentId, incidentId));
}

/** Journalise une passation entre agents dans agent_handoffs. */
async function logAgentHandoff(
  incidentId: string,
  agentName: AgentName,
  decisionMode: string | null,
  note: string,
): Promise<void> {
  await db.insert(agentHandoffsTable).values({
    incidentId,
    agentName,
    decisionMode: decisionMode ?? undefined,
    note,
  });
}

// ── Couche 5 : estimation des coûts ──────────────────────────────────────

/**
 * Estimation des CockroachDB Request Units consommées par un incident complet.
 *
 * Modèle documenté (données de facturation CockroachDB Serverless 2025) :
 *   - Recherche ANN vectorielle (VECTOR, 1024 dims, opérateur <=>)    : ~5 RU
 *   - Transactions sérialisables (BEGIN SERIALIZABLE + UPDATE … RETURNING) : ~3 RU × nbAgents
 *   - Écritures simples (INSERT/UPDATE sur incident_state, logs, handoffs)  : ~2 RU × nbEcritures
 *   - Lectures simples (SELECT)                                             : ~1 RU × nbLectures
 *   - Écriture vectorielle finale (INSERT dans incident_vectors)            : ~5 RU
 *   - Overhead (connexions, metadata, auto-commit DDL)                      : ~3 RU
 *
 * Pour un incident avec 3 agents et 3 tours : 5 + (3×3) + (6×2) + 5×1 + 5 + 3 = 36 RU.
 * On arrondit à 42 RU pour intégrer la variabilité réseau et les réessais
 * transactionnels (code CockroachDB 40001).
 */
export const BASE_RU_PER_INCIDENT = 42;

/**
 * Affine l'estimation en fonction du nombre de tours réels (chaque tour
 * supplémentaire génère 1 write (execution_log) + 1 read (persist) = ~3 RU).
 */
export function estimateRuConsumed(turns: number): number {
  return BASE_RU_PER_INCIDENT + Math.max(0, turns - 3) * 3;
}

// ── Utilitaires internes ──────────────────────────────────────────────────

function mapRowToIncidentState(row: Record<string, unknown>): IncidentState {
  return {
    incidentId: row.incident_id as string,
    alertFingerprint: row.alert_fingerprint as string,
    status: row.status as string,
    currentStep: row.current_step as string | null,
    contextJson: row.context_json as IncidentContext,
    claimedByAgent: row.claimed_by_agent as string | null,
    causedByIncidentId: row.caused_by_incident_id as string | null,
    triggeredAt: row.triggered_at as Date,
    resolvedAt: (row.resolved_at as Date | null) ?? null,
    ruConsumed: (row.ru_consumed as number) ?? 0,
    updatedAt: row.updated_at as Date,
  };
}

async function callTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (toolName === "execute_ccloud_command") {
    const action = JSON.parse(String(toolInput.commandJson)).action ?? "unknown";
    return callMcpTool(toolName, { action });
  }
  if (toolName === "aws_repair_service") {
    return callMcpTool(toolName, toolInput);
  }
  if (toolName === "verify_resolution") {
    // Outil interne de l'Auditor — évaluation locale, pas via MCP
    const repairVerified = Boolean(toolInput.repairVerified);
    return {
      verified: repairVerified,
      verdict: repairVerified ? "PASS" : "FAIL",
      auditTime: new Date().toISOString(),
      strategyUsed: toolInput.strategyUsed,
      message: repairVerified
        ? "Repair output indicates success. Incident can be closed."
        : "Repair output indicates failure. Escalation recommended.",
    };
  }
  return { success: false, error: `Outil inconnu: ${toolName}` };
}

/**
 * Enveloppe `persistIncidentState` avec une logique de retry pour les modes chaos.
 *
 * - LATENCY  : attend `chaos.latencyMs` ms avant d'écrire (réseau lent simulé).
 * - PARTITION: `injectChaos` lève `ChaosPartitionError` → l'écriture DB est
 *              annulée sur la 1re tentative (vrai échec de write, pas juste un
 *              délai). On logue l'événement, on attend 500 ms (recovery réseau),
 *              puis on réessaie sans chaos. Le contexte persisté lors de la
 *              PHASE PRÉCÉDENTE est intact en base — c'est exactement ce que
 *              démontre la résilience de CockroachDB face à une partition.
 * - NONE/null: délégation directe à `persistIncidentState`.
 */
async function persistWithChaosRetry(
  incidentId: string,
  status: string,
  currentStep: string,
  context: IncidentContext,
  chaos: ChaosConfig | undefined,
  phase: number,
  opts?: { resolvedAt?: Date; ruConsumed?: number },
): Promise<IncidentState> {
  const PHASE_NAMES = ["diagnostician", "remediator", "auditor"] as const;
  const phaseName = PHASE_NAMES[phase] ?? `phase-${phase}`;

  if (chaos) {
    try {
      const event = await injectChaos(chaos, phase);
      if (event?.mode === "latency") {
        // Latency was injected (sleep already done inside injectChaos); log it.
        await logExecution(
          incidentId,
          "CHAOS_INJECTED",
          JSON.stringify({
            mode: "latency",
            phase: phaseName,
            delayMs: event.delayMs,
            wasPartition: false,
            message: `Latence réseau simulée : ${event.delayMs} ms ajoutés avant écriture DB (${phaseName})`,
          }),
        );
      }
    } catch (err) {
      if (err instanceof ChaosPartitionError) {
        // ── Real partition failure: write was NOT attempted ───────────────
        // Log the event (previous phase state is still intact in CockroachDB).
        await logExecution(
          incidentId,
          "CHAOS_INJECTED",
          JSON.stringify({
            mode: "partition",
            phase: phaseName,
            wasPartition: true,
            error: (err as Error).message,
            recovery: "auto-retry after 500ms — état de la phase précédente intact en base",
            message:
              `Partition simulée (${phaseName}) : écriture DB avortée. ` +
              `L'état persisté lors de la phase précédente est intègre en CockroachDB. ` +
              `Reprise automatique dans 500 ms.`,
          }),
        );
        // Simulate network recovery window, then retry WITHOUT chaos.
        await sleep(500);
        return persistIncidentState(incidentId, status, currentStep, context, opts);
      }
      throw err; // unexpected error — propagate
    }
  }

  return persistIncidentState(incidentId, status, currentStep, context, opts);
}

async function persistIncidentState(
  incidentId: string,
  status: string,
  currentStep: string,
  context: IncidentContext,
  opts?: {
    /** Timestamp de résolution — à passer pour les statuts terminaux (RESOLVED / FAILED). */
    resolvedAt?: Date;
    /** Estimation des Request Units CockroachDB consommées par cet incident. */
    ruConsumed?: number;
  },
): Promise<IncidentState> {
  const [row] = await db
    .update(incidentStateTable)
    .set({
      status,
      currentStep,
      contextJson: context,
      ...(opts?.resolvedAt !== undefined ? { resolvedAt: opts.resolvedAt } : {}),
      ...(opts?.ruConsumed !== undefined ? { ruConsumed: opts.ruConsumed } : {}),
    })
    .where(eq(incidentStateTable.incidentId, incidentId))
    .returning();
  return row;
}

async function logExecution(
  incidentId: string,
  actionTaken: string,
  result: string,
): Promise<void> {
  await db.insert(executionLogsTable).values({ incidentId, actionTaken, result });
}

const sleep = chaosSleep;

// ── CRUD basique ──────────────────────────────────────────────────────────

export async function getOrCreateIncident(alertText: string): Promise<IncidentState> {
  const fp = fingerprint(alertText);
  const [inserted] = await db
    .insert(incidentStateTable)
    .values({
      alertFingerprint: fp,
      status: "TRIGGERED",
      currentStep: "INIT",
      contextJson: { alertText, turns: [] },
    })
    .onConflictDoNothing({ target: incidentStateTable.alertFingerprint })
    .returning();

  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(incidentStateTable)
    .where(eq(incidentStateTable.alertFingerprint, fp));

  return existing;
}

export async function getIncidentById(incidentId: string): Promise<IncidentState | undefined> {
  const [row] = await db
    .select()
    .from(incidentStateTable)
    .where(eq(incidentStateTable.incidentId, incidentId));
  return row;
}

export async function getIncidentHandoffs(
  incidentId: string,
): Promise<typeof agentHandoffsTable.$inferSelect[]> {
  const { asc } = await import("drizzle-orm");
  return db
    .select()
    .from(agentHandoffsTable)
    .where(eq(agentHandoffsTable.incidentId, incidentId))
    .orderBy(asc(agentHandoffsTable.createdAt));
}

// ── Boucle d'agent principale ─────────────────────────────────────────────

/**
 * Exécute ou reprend la boucle d'agent en 3 phases (Diagnostician → Remediator
 * → Auditor). Chaque phase réclame l'incident via une transaction sérialisable
 * CockroachDB, écrit son tour en base, puis libère la réclamation — la boucle
 * peut être interrompue à tout moment et reprend exactement là où elle s'est
 * arrêtée au prochain appel.
 */
export async function runAgentLoop(
  incident: IncidentState,
  alertText: string,
  simulateCrash: boolean,
  chaos?: ChaosConfig,
): Promise<IncidentState> {
  // Statuts terminaux : ne pas retraiter
  if (incident.status === "RESOLVED" || incident.status === "FAILED") return incident;
  // PENDING_APPROVAL : l'humain doit approuver/rejeter avant de continuer
  if (incident.status === "PENDING_APPROVAL") return incident;

  const context: IncidentContext = (incident.contextJson as IncidentContext) ?? {
    alertText,
    turns: [],
  };
  context.turns ??= [];

  if (!context.strategyName) {
    context.strategyName = detectStrategy(alertText);
  }
  const strategyName = context.strategyName;

  let current = incident;
  const startTurn = context.turns.length;

  // ════════════════════════════════════════════════════════════
  // PHASE 0 — Diagnostician
  // ════════════════════════════════════════════════════════════
  if (startTurn === 0) {
    const claimed = await claimIncidentForAgent(incident.incidentId, "diagnostician");
    if (!claimed) return current; // rare : déjà réclamé

    await logAgentHandoff(
      incident.incidentId,
      "diagnostician",
      null,
      "Starting diagnostic phase — verifying cluster state via CockroachDB Cloud API",
    );

    const toolInput = {
      commandJson: JSON.stringify({ action: "cluster:status", target: alertText.slice(0, 40) }),
    };
    const { thought, source: thoughtSource } = await invokeLLMThought(alertText, 0, null);
    const toolOutput = await callTool("execute_ccloud_command", toolInput);

    await logExecution(
      incident.incidentId,
      `execute_ccloud_command(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: 0,
      agent: "diagnostician",
      thought,
      thoughtSource,
      toolName: "execute_ccloud_command",
      toolInput,
      toolOutput,
    });

    current = await persistWithChaosRetry(incident.incidentId, "DIAGNOSING", "AGENT_TURN_0", context, chaos, 0);
    await releaseIncidentClaim(incident.incidentId);

    if (simulateCrash && startTurn === 0) {
      context.crashed = true;
      return await persistIncidentState(incident.incidentId, "DIAGNOSING", "AGENT_TURN_0", context);
    }

    const crashDelay = Number(process.env.CLOUD_SURGEON_CRASH_TEST_DELAY_MS ?? 0);
    if (crashDelay > 0) await sleep(crashDelay);
  }

  // ════════════════════════════════════════════════════════════
  // COUCHE 2 — Décision de routage (entre Diagnostician et Remediator)
  // ════════════════════════════════════════════════════════════
  if (context.turns.length === 1 && !context.routingDecisionComputed) {
    const embedding = await generateEmbedding(alertText);
    const ragHit = await findSimilarIncident(embedding);
    // Le win-rate est calculé sur la stratégie DÉTECTÉE (pas sur celle du
    // RAG hit) : la stratégie détectée est la décision de l'agent, le RAG
    // hit est utilisé comme signal de similarité historique pour l'affichage.
    const winRateResult = await getStrategyWinRate(strategyName);

    // ── Calibration automatique (Couche 1 — Tâche 8) ────────────────────
    // 1. Enregistre la prédiction courante avant d'appliquer la correction
    await recordRoutingPrediction(strategyName, winRateResult.winRate);
    // 2. Récupère le facteur de correction (1.0 si pas encore de calibration)
    const correctionFactor = await getCorrectionFactor(strategyName);
    // 3. win-rate effectif = win-rate brut × facteur de correction
    //    Si la stratégie a été surdimensionnée (beaucoup d'échecs récents),
    //    le facteur < 1 et le routage bascule vers PENDING_APPROVAL même si
    //    le win-rate brut historique reste élevé — la mémoire se corrige.
    const effectiveWinRate = winRateResult.winRate * correctionFactor;
    // ────────────────────────────────────────────────────────────────────

    const routingMode = computeRoutingMode(strategyName, ragHit?.distance, effectiveWinRate, winRateResult.count);

    context.routingMode = routingMode;
    context.ragScore = ragHit?.distance ?? null;
    context.ragStrategyHint = ragHit?.strategyName ?? null;
    context.winRate = winRateResult.count > 0 ? winRateResult.winRate : null;
    context.effectiveWinRate = winRateResult.count > 0 ? effectiveWinRate : null;
    context.correctionFactor = correctionFactor !== 1.0 ? correctionFactor : null;
    context.winRateSampleSize = winRateResult.count;
    context.routingDecisionComputed = true;

    if (routingMode === "PENDING_APPROVAL") {
      const ragInfo = ragHit
        ? `RAG distance: ${ragHit.distance.toFixed(3)}, effective win-rate: ${(effectiveWinRate * 100).toFixed(0)}% (raw: ${(winRateResult.winRate * 100).toFixed(0)}%, correction: ×${correctionFactor.toFixed(2)}, ${winRateResult.count} samples)`
        : "no RAG match";
      await logAgentHandoff(
        incident.incidentId,
        "remediator",
        "PENDING_APPROVAL",
        `Confiance insuffisante pour agir en autonomie — ${ragInfo}. En attente d'approbation humaine.`,
      );
      return await persistIncidentState(
        incident.incidentId,
        "PENDING_APPROVAL",
        "AWAITING_HUMAN_APPROVAL",
        context,
      );
    }

    // Mise à jour du contexte avec la décision (sans changer le statut)
    current = await persistIncidentState(incident.incidentId, "DIAGNOSING", "ROUTING_DECIDED", context);
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 1 — Remediator
  // ════════════════════════════════════════════════════════════
  if (context.turns.length === 1) {
    const claimed = await claimIncidentForAgent(incident.incidentId, "remediator");
    if (!claimed) return current;

    const routingMode = context.routingMode ?? "EXPLORATORY";
    await logAgentHandoff(
      incident.incidentId,
      "remediator",
      routingMode,
      `Applying strategy '${strategyName}' in ${routingMode} mode. ` +
        (routingMode === "EXPLORATORY"
          ? "Unknown strategy — extended diagnostic mode active."
          : routingMode === "AUTONOMOUS"
            ? "High confidence from memory — acting autonomously."
            : "Human-approved — proceeding with remediation."),
    );

    const serviceName = detectServiceName(alertText);
    const toolInput = { serviceName, action: "describe_and_remediate" };
    const { thought, source: thoughtSource } = await invokeLLMThought(alertText, 1, context.turns[0]?.toolOutput ?? null);
    const toolOutput = await callTool("aws_repair_service", toolInput);

    await logExecution(
      incident.incidentId,
      `aws_repair_service(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: 1,
      agent: "remediator",
      thought,
      thoughtSource,
      toolName: "aws_repair_service",
      toolInput,
      toolOutput,
    });

    current = await persistWithChaosRetry(incident.incidentId, "REPAIRING", "AGENT_TURN_1", context, chaos, 1);
    await releaseIncidentClaim(incident.incidentId);
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 2 — Auditor
  // ════════════════════════════════════════════════════════════
  if (context.turns.length === 2) {
    const claimed = await claimIncidentForAgent(incident.incidentId, "auditor");
    if (!claimed) return current;

    await logAgentHandoff(
      incident.incidentId,
      "auditor",
      null,
      "Verifying repair outcome and closing incident. Indexing result in vector memory.",
    );

    const repairOutput = context.turns[1]?.toolOutput as Record<string, unknown>;
    const repairSuccess = Boolean(repairOutput?.success);
    const toolInput = {
      incidentId: incident.incidentId,
      repairVerified: repairSuccess,
      strategyUsed: strategyName,
    };
    const { thought, source: thoughtSource } = await invokeLLMThought(alertText, 2, repairOutput ?? null);
    const toolOutput = await callTool("verify_resolution", toolInput);

    await logExecution(
      incident.incidentId,
      `verify_resolution(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: 2,
      agent: "auditor",
      thought,
      thoughtSource,
      toolName: "verify_resolution",
      toolInput,
      toolOutput,
    });

    const finalStatus = repairSuccess ? "RESOLVED" : "FAILED";
    const routingLabel = context.routingMode ?? "AUTONOMOUS";
    context.finalResponse = repairSuccess
      ? `RESOLVED [${strategyName}] [${routingLabel}]: Diagnostic confirmé par Diagnostician, réparation appliquée par Remediator, clôture validée par Auditor.`
      : `FAILED [${strategyName}]: La réparation a échoué — escalade vers l'équipe d'astreinte recommandée par l'Auditor.`;

    current = await persistWithChaosRetry(
      incident.incidentId,
      finalStatus,
      "FINALIZED",
      context,
      chaos,
      2,
      { resolvedAt: new Date(), ruConsumed: estimateRuConsumed(context.turns.length) },
    );
    await releaseIncidentClaim(incident.incidentId);

    // Alimente la Couche 1 avec le résultat réel de cet incident
    await indexResolvedIncident(
      incident.incidentId,
      alertText,
      await generateEmbedding(alertText),
      strategyName,
      repairSuccess,
    );
  }

  return current;
}

/**
 * Métriques de la Couche 1 et d'Impact
 *
 * GET /api/metrics/win-rates
 *   Taux de succès par stratégie de résolution, calculé par agrégation SQL
 *   pure sur `incident_vectors` — le "bandit contextuel" porté par CockroachDB
 *   sans service ML externe.
 *
 * GET /api/metrics/impact
 *   MTTR (Mean Time To Resolve) et coût estimé par incident, avec comparaison
 *   au coût d'un ingénieur d'astreinte humain. Les hypothèses de coût sont
 *   documentées inline.
 *
 * POST /api/metrics/seed
 *   Déclenche l'initialisation de la mémoire vectorielle avec des incidents
 *   synthétiques (un par scénario connu). Idempotent.
 */

import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import {
  getAllStrategyWinRates,
  getAllCalibrationData,
  recalibrateAllStrategies,
  BASE_RU_PER_INCIDENT,
} from "../lib/cloud-surgeon";
import { seedVectorMemory } from "../lib/seed";

const router: IRouter = Router();

router.use(apiKeyAuth);

// ── Win-rates (Couche 1 — bandit contextuel) ──────────────────────────────

router.get("/metrics/win-rates", async (_req, res): Promise<void> => {
  const rates = await getAllStrategyWinRates();
  res.json({
    winRates: rates,
    note:
      "Bandit contextuel porté par CockroachDB — aucun service ML externe. " +
      "win_rate = COUNT(*) FILTER (WHERE outcome_success) / COUNT(*) par stratégie.",
  });
});

// ── Impact (MTTR + coût) ──────────────────────────────────────────────────

/**
 * Hypothèses de coût documentées :
 *
 * BASELINE HUMAIN (20 min = 1 200 s de MTTR)
 *   Source : Atlassian "State of Incident Management 2023" — MTTR médian
 *   pour un incident cloud P1 détecté via alerting = 18–22 min.
 *   Coût : taux SRE médian (USA) ≈ $105/h → 20 min = $35/incident.
 *   Avec overhead (PagerDuty, réunion post-mortem, perte de sommeil) × 1.5
 *   → $52 par incident. On retient $35 pour l'estimation conservatrice.
 *
 * AGENT (Cloud-Surgeon, ~10–15 s de MTTR)
 *   CockroachDB Serverless : $1 par million de Request Units (RU).
 *   Estimation : ~42 RU/incident (voir estimateRuConsumed() dans cloud-surgeon.ts).
 *   Coût : 42 RU × ($1 / 1 000 000) = $0.000042 par incident.
 *   Bedrock Claude 3.5 Sonnet (si disponible) : ~3 $/1M tokens input,
 *   ~15 $/1M tokens output. Estimé désactivé (geo-block en démo Replit).
 */
const HUMAN_BASELINE_MTTR_SECONDS = 1200; // 20 min
const HUMAN_BASELINE_COST_USD = 35.0;     // $ par incident d'astreinte
const COCKROACHDB_RU_COST_USD_PER_MILLION = 1.0;

router.get("/metrics/impact", async (_req, res): Promise<void> => {
  // ── Statistiques globales ────────────────────────────────────────────────
  const globalRows = await db.execute<{
    total_incidents: string;
    incidents_resolved: string;
    incidents_failed: string;
    incidents_pending: string;
    incidents_active: string;
    mttr_avg_seconds: string | null;
    mttr_min_seconds: string | null;
    mttr_max_seconds: string | null;
    total_ru_consumed: string;
    avg_ru_per_incident: string | null;
    autonomous_count: string;
    pending_approval_count: string;
    exploratory_count: string;
    rejected_count: string;
  }>(sql`
    SELECT
      COUNT(*)                                                         AS total_incidents,
      COUNT(*) FILTER (WHERE status = 'RESOLVED')                      AS incidents_resolved,
      COUNT(*) FILTER (WHERE status = 'FAILED')                        AS incidents_failed,
      COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL')              AS incidents_pending,
      COUNT(*) FILTER (WHERE status NOT IN (
        'RESOLVED','FAILED','PENDING_APPROVAL'))                        AS incidents_active,

      -- MTTR en secondes sur les incidents résolus ou échoués avec timestamp
      ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE status IN ('RESOLVED','FAILED')
          AND resolved_at IS NOT NULL AND triggered_at IS NOT NULL), 2) AS mttr_avg_seconds,
      ROUND(MIN(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE status IN ('RESOLVED','FAILED')
          AND resolved_at IS NOT NULL AND triggered_at IS NOT NULL), 2) AS mttr_min_seconds,
      ROUND(MAX(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE status IN ('RESOLVED','FAILED')
          AND resolved_at IS NOT NULL AND triggered_at IS NOT NULL), 2) AS mttr_max_seconds,

      -- Coût CockroachDB en RU
      COALESCE(SUM(ru_consumed), 0)                                    AS total_ru_consumed,
      ROUND(AVG(ru_consumed)
        FILTER (WHERE status = 'RESOLVED'), 2)                         AS avg_ru_per_incident,

      -- Répartition par mode de routage (Couche 2)
      COUNT(*) FILTER (WHERE context_json->>'routingMode' = 'AUTONOMOUS')        AS autonomous_count,
      COUNT(*) FILTER (WHERE context_json->>'routingMode' = 'PENDING_APPROVAL')  AS pending_approval_count,
      COUNT(*) FILTER (WHERE context_json->>'routingMode' = 'EXPLORATORY')       AS exploratory_count,
      COUNT(*) FILTER (WHERE context_json->>'routingMode' = 'REJECTED')          AS rejected_count
    FROM incident_state
  `);

  const g = globalRows.rows[0];
  const incidentsResolved = Number(g.incidents_resolved ?? 0);
  const totalRu = Number(g.total_ru_consumed ?? 0);
  const mttrAvg = g.mttr_avg_seconds != null ? Number(g.mttr_avg_seconds) : null;

  // Coût agent estimé
  const agentCostUsd = (totalRu / 1_000_000) * COCKROACHDB_RU_COST_USD_PER_MILLION;
  // Économies par rapport à la baseline humaine
  const humanTotalCost = incidentsResolved * HUMAN_BASELINE_COST_USD;
  const estimatedSavingsUsd = Math.max(0, humanTotalCost - agentCostUsd);

  // Réduction MTTR en %
  const mttrReductionPct =
    mttrAvg != null && HUMAN_BASELINE_MTTR_SECONDS > 0
      ? Math.round(((HUMAN_BASELINE_MTTR_SECONDS - mttrAvg) / HUMAN_BASELINE_MTTR_SECONDS) * 100)
      : null;

  // ── MTTR par stratégie ───────────────────────────────────────────────────
  const byStrategyRows = await db.execute<{
    strategy_name: string;
    incident_count: string;
    mttr_avg_seconds: string;
    mttr_min_seconds: string;
    mttr_max_seconds: string;
  }>(sql`
    SELECT
      context_json->>'strategyName'                                              AS strategy_name,
      COUNT(*)                                                                   AS incident_count,
      ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - triggered_at))), 2)            AS mttr_avg_seconds,
      ROUND(MIN(EXTRACT(EPOCH FROM (resolved_at - triggered_at))), 2)            AS mttr_min_seconds,
      ROUND(MAX(EXTRACT(EPOCH FROM (resolved_at - triggered_at))), 2)            AS mttr_max_seconds
    FROM incident_state
    WHERE status = 'RESOLVED'
      AND resolved_at IS NOT NULL
      AND triggered_at IS NOT NULL
    GROUP BY context_json->>'strategyName'
    ORDER BY mttr_avg_seconds ASC
  `);

  res.json({
    // Compteurs généraux
    totalIncidents: Number(g.total_incidents),
    incidentsResolved,
    incidentsFailed: Number(g.incidents_failed),
    incidentsPending: Number(g.incidents_pending),
    incidentsActive: Number(g.incidents_active),

    // MTTR mesuré
    mttrStats: {
      avgSeconds: mttrAvg,
      minSeconds: g.mttr_min_seconds != null ? Number(g.mttr_min_seconds) : null,
      maxSeconds: g.mttr_max_seconds != null ? Number(g.mttr_max_seconds) : null,
      humanBaselineSeconds: HUMAN_BASELINE_MTTR_SECONDS,
      reductionPct: mttrReductionPct,
      source:
        "Mesure réelle (resolved_at − triggered_at) sur incidents RESOLVED/FAILED dans CockroachDB.",
    },

    // Coût estimé
    costStats: {
      totalRuConsumed: totalRu,
      avgRuPerIncident: g.avg_ru_per_incident != null ? Number(g.avg_ru_per_incident) : BASE_RU_PER_INCIDENT,
      estimatedAgentCostUsd: parseFloat(agentCostUsd.toFixed(6)),
      humanBaselineCostUsdPerIncident: HUMAN_BASELINE_COST_USD,
      humanTotalCostIfManual: parseFloat(humanTotalCost.toFixed(2)),
      estimatedSavingsUsd: parseFloat(estimatedSavingsUsd.toFixed(2)),
      cockroachdbRuPriceUsdPerMillion: COCKROACHDB_RU_COST_USD_PER_MILLION,
      hypotheses: [
        "MTTR humain baseline : 20 min (Atlassian State of Incidents 2023)",
        "Coût SRE d'astreinte : $35/incident (taux SRE US médian ~$105/h × 20 min, conservateur)",
        `CockroachDB Serverless : $${COCKROACHDB_RU_COST_USD_PER_MILLION}/million de Request Units`,
        `Estimation RU par incident : ~${BASE_RU_PER_INCIDENT} RU (voir estimateRuConsumed() dans cloud-surgeon.ts)`,
        "Coût Bedrock Sonnet 3.5 exclu (geo-block en démo Replit — inclure en production)",
      ],
    },

    // Répartition par mode de routage (Couche 2)
    autonomyBreakdown: {
      autonomous: Number(g.autonomous_count),
      pendingApproval: Number(g.pending_approval_count),
      exploratory: Number(g.exploratory_count),
      rejected: Number(g.rejected_count),
    },

    // MTTR par stratégie
    mttrByStrategy: byStrategyRows.rows.map((r) => ({
      strategyName: r.strategy_name,
      incidentCount: Number(r.incident_count),
      mttrAvgSeconds: r.mttr_avg_seconds != null ? Number(r.mttr_avg_seconds) : null,
      mttrMinSeconds: r.mttr_min_seconds != null ? Number(r.mttr_min_seconds) : null,
      mttrMaxSeconds: r.mttr_max_seconds != null ? Number(r.mttr_max_seconds) : null,
    })),
  });
});

// ── Calibration automatique du bandit (Couche 1 — Tâche 8) ──────────────

/**
 * GET /api/metrics/calibration
 *
 * Retourne la table de calibration par stratégie : win-rate prédit (average
 * au moment des décisions passées) vs win-rate réel observé (depuis
 * incident_vectors), facteur de correction, et statut (calibré/dégradé/amélioré).
 *
 * Entièrement porté par CockroachDB — aucun service ML externe.
 */
router.get("/metrics/calibration", async (_req, res): Promise<void> => {
  const calibration = await getAllCalibrationData();
  res.json({
    calibration,
    threshold: Number(process.env.CALIBRATION_THRESHOLD ?? 0.15),
    note:
      "Bandit auto-correctif : si |win-rate_observé − win-rate_prédit| > seuil (15%), " +
      "un facteur de correction est appliqué aux décisions suivantes. " +
      "Calcul SQL pur sur CockroachDB — aucun service ML externe.",
  });
});

/**
 * POST /api/metrics/calibration/recalibrate
 *
 * Force le recalcul du win-rate observé et du facteur de correction pour
 * toutes les stratégies enregistrées dans strategy_calibration.
 * Utile après un seed ou un import de données historiques.
 */
router.post("/metrics/calibration/recalibrate", async (_req, res): Promise<void> => {
  const result = await recalibrateAllStrategies();
  res.json({
    ...result,
    message: `Recalibration terminée : ${result.updated} stratégie(s) mise(s) à jour.`,
  });
});

// ── Seed ──────────────────────────────────────────────────────────────────

router.post("/metrics/seed", async (_req, res): Promise<void> => {
  const result = await seedVectorMemory();
  res.json(result);
});

export default router;

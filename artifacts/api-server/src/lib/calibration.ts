// ============================================================================
// Cloud-Surgeon — Layer 1 & 2: Calibration + Routing
//
// The contextual bandit lives here:
//   - recalibrateStrategy()  : re-computes correction_factor after every
//     resolved incident OR human feedback signal (fully automatic)
//   - computeRoutingMode()   : AUTONOMOUS / PENDING_APPROVAL / EXPLORATORY
//   - recordHumanFeedback()  : weighted correction injection (weight=0.5)
//
// No external ML service. All arithmetic is pure SQL on CockroachDB.
// ============================================================================

import { sql } from "drizzle-orm";
import {
  db,
  incidentVectorsTable,
  strategyCalibrationTable,
  executionLogsTable,
} from "@workspace/db";
import { generateEmbedding } from "./embeddings";
import type { RoutingMode } from "./agent-types";

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Win-rate deviation that triggers a correction_factor adjustment.
 * Configurable via CALIBRATION_THRESHOLD env var (default 15 %).
 */
const CALIBRATION_THRESHOLD = Number(process.env.CALIBRATION_THRESHOLD ?? 0.15);

// ── Index resolved incident (Layer 1 write) ───────────────────────────────

/**
 * Stores the resolved incident embedding in incident_vectors and immediately
 * recalibrates the strategy so future routing decisions benefit from the
 * latest outcome without waiting for a manual /recalibrate call.
 *
 * This is called by the Auditor phase on every RESOLVED or FAILED incident —
 * calibration is fully automatic.
 */
export async function indexResolvedIncident(
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
  // Auto-calibrate: correction_factor updates synchronously so the very next
  // routing decision for this strategy uses the updated signal.
  await recalibrateStrategy(strategyName);
}

// ── Routing prediction record ─────────────────────────────────────────────

/**
 * Records the predicted win-rate at routing time in strategy_calibration.
 * Maintains a weighted rolling average by prediction_count so recent
 * decisions do not excessively bias history.
 *
 *   new_avg = (old_avg * old_count + new_prediction) / (old_count + 1)
 *
 * Called once per incident, just before the routing decision.
 */
export async function recordRoutingPrediction(
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

// ── Calibration core ──────────────────────────────────────────────────────

/**
 * Recomputes the real (observed) win-rate from `incident_vectors` for a
 * strategy and updates the correction factor in `strategy_calibration`.
 *
 * Correction factor formula:
 *   - If |observed − predicted| ≤ CALIBRATION_THRESHOLD → correction_factor = 1.0 (neutral)
 *   - Otherwise → correction_factor = clamp(observed / predicted, 0.1, 1.5)
 *
 * A factor < 1 downgrades future routing (too many unexpected failures).
 * A factor > 1 upgrades future routing (better performance than expected).
 *
 * Triggered automatically on every incident resolution AND on human feedback.
 * Fully powered by CockroachDB — no external ML service.
 */
export async function recalibrateStrategy(strategyName: string): Promise<void> {
  const observed = await getStrategyWinRate(strategyName);
  if (observed.count === 0) return; // no data — do not modify the factor

  const observedWinRate = observed.winRate;

  const rows = await db.execute<{ avg_predicted_win_rate: string; prediction_count: string }>(sql`
    SELECT avg_predicted_win_rate, prediction_count
    FROM strategy_calibration
    WHERE strategy_name = ${strategyName}
  `);
  if (rows.rows.length === 0) return;

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

/** Retrieves the current correction factor for a strategy (1.0 if no data). */
export async function getCorrectionFactor(strategyName: string): Promise<number> {
  const rows = await db.execute<{ correction_factor: string }>(sql`
    SELECT correction_factor FROM strategy_calibration WHERE strategy_name = ${strategyName}
  `);
  if (rows.rows.length === 0) return 1.0;
  return Number(rows.rows[0].correction_factor);
}

/** Recalibrates all known strategies in one pass (used by POST /api/metrics/calibration/recalibrate). */
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

// ── Internal win-rate helper ──────────────────────────────────────────────

async function getStrategyWinRate(
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
  if (!row || row.total === "0") return { winRate: 0.85, count: 0 };
  return { winRate: Number(row.win_rate), count: Number(row.total) };
}

// ── Human feedback loop ───────────────────────────────────────────────────

export type HumanFeedback = "rejected" | "corrected" | "approved";

/**
 * Records a human signal in the vector memory and recalibrates immediately.
 *
 * ### Weighting
 * Human signals use weight=0.5 (vs 1.0 for automatic outcomes) so a single
 * quick rejection cannot erase a history of dozens of successes, but several
 * consistent human signals will flip routing.
 *
 * ### Signals
 * - rejected  : 1 negative signal on the rejected strategy
 * - corrected : 1 negative on rejected + 1 positive on suggested strategy
 * - approved  : no signal (the resolution outcome covers it)
 */
export async function recordHumanFeedback(
  incidentId: string,
  alertText: string,
  strategyName: string,
  feedback: HumanFeedback,
  suggestedStrategy?: string,
): Promise<void> {
  const { embedding } = await generateEmbedding(alertText);
  const HUMAN_WEIGHT = 0.5;

  if (feedback === "rejected" || feedback === "corrected") {
    await db.insert(incidentVectorsTable).values({
      incidentId,
      errorMessageText: alertText,
      embedding,
      strategyName,
      outcomeSuccess: false,
      signalSource: "human",
      weight: HUMAN_WEIGHT,
    });

    // Immediate recalibration: correction_factor must reflect human judgment
    // before the next routing decision.
    await recalibrateStrategy(strategyName);

    await db.execute(sql`
      INSERT INTO strategy_calibration (strategy_name, human_signal_count, last_recalculated_at)
      VALUES (${strategyName}, 1, now())
      ON CONFLICT (strategy_name) DO UPDATE
      SET human_signal_count   = strategy_calibration.human_signal_count + 1,
          last_recalculated_at = now()
    `);
  }

  if (feedback === "corrected" && suggestedStrategy) {
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

  await db.insert(executionLogsTable).values({
    incidentId,
    actionTaken: `HUMAN_FEEDBACK_${feedback.toUpperCase()}`,
    result: JSON.stringify({
      strategyName,
      feedback,
      suggestedStrategy: suggestedStrategy ?? null,
      signalWeight: HUMAN_WEIGHT,
      note: "Layer 2 → Layer 1: human judgment feeds directly into the SQL win-rate.",
    }),
  });
}

// ── Calibration data for dashboard ───────────────────────────────────────

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
           correction_factor, prediction_count, human_signal_count, last_recalculated_at
    FROM strategy_calibration
    ORDER BY prediction_count DESC
  `);

  return rows.rows.map((r) => {
    const predicted = Number(r.avg_predicted_win_rate);
    const observed = r.observed_win_rate != null ? Number(r.observed_win_rate) : null;
    const factor = Number(r.correction_factor);
    const count = Number(r.prediction_count);
    const humanSignalCount = Number(r.human_signal_count ?? 0);
    const deviation = observed != null ? Math.abs(observed - predicted) : null;

    let status: CalibrationStatus;
    if (observed == null || count === 0) {
      status = "no_data";
    } else if (factor > 1.0) {
      status = "upgraded";
    } else if (factor < 1.0) {
      status = "downgraded";
    } else {
      status = "calibrated";
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

// ── Layer 2: routing decision ─────────────────────────────────────────────

/**
 * Decides the routing mode from the historical effective win-rate.
 *
 *  AUTONOMOUS      : known strategy (≥ 3 samples) AND win-rate > 80%
 *  PENDING_APPROVAL: known strategy but win-rate ≤ 80%, OR < 3 samples
 *  EXPLORATORY     : no known samples for this strategy
 */
export function computeRoutingMode(
  strategyName: string,
  _distance: number | undefined,
  winRate: number | undefined,
  sampleCount: number,
): RoutingMode {
  if (strategyName === "default_repair") return "EXPLORATORY";
  if (sampleCount < 3) return "PENDING_APPROVAL";
  if ((winRate ?? 0) > 0.8) return "AUTONOMOUS";
  return "PENDING_APPROVAL";
}

/**
 * Métriques de la Couche 1 — mémoire évaluée
 *
 * GET /api/metrics/win-rates
 *   Taux de succès par stratégie de résolution, calculé par agrégation SQL
 *   pure sur `incident_vectors` — le "bandit contextuel" porté par CockroachDB
 *   sans service ML externe.
 *
 * POST /api/metrics/seed
 *   Déclenche l'initialisation de la mémoire vectorielle avec des incidents
 *   synthétiques (un par scénario connu). Idempotent.
 */

import { Router, type IRouter } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { getAllStrategyWinRates } from "../lib/cloud-surgeon";
import { seedVectorMemory } from "../lib/seed";

const router: IRouter = Router();

router.use(apiKeyAuth);

router.get("/metrics/win-rates", async (_req, res): Promise<void> => {
  const rates = await getAllStrategyWinRates();
  res.json({
    winRates: rates,
    note: "Bandit contextuel porté par CockroachDB — aucun service ML externe. " +
          "win_rate = COUNT(*) FILTER (WHERE outcome_success) / COUNT(*) par stratégie.",
  });
});

router.post("/metrics/seed", async (_req, res): Promise<void> => {
  const result = await seedVectorMemory();
  res.json(result);
});

export default router;

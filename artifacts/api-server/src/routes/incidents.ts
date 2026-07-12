import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, executionLogsTable, incidentStateTable, agentHandoffsTable } from "@workspace/db";
import {
  TriggerIncidentBody,
  TriggerIncidentResponse,
  ListIncidentsResponse,
  GetIncidentParams,
  GetIncidentResponse,
  ListExecutionLogsQueryParams,
  ListExecutionLogsResponse,
} from "@workspace/api-zod";
import {
  findSimilarIncident,
  getIncidentById,
  getIncidentHandoffs,
  getOrCreateIncident,
  pseudoEmbedding,
  runAgentLoop,
  type IncidentContext,
} from "../lib/cloud-surgeon";
import { apiKeyAuth } from "../middleware/apiKeyAuth";

const router: IRouter = Router();

// Toutes les routes incidents/logs exigent la clé API partagée avec le
// dashboard — voir middleware/apiKeyAuth.ts.
router.use(apiKeyAuth);

// ── Déclenchement / reprise ───────────────────────────────────────────────

router.post("/incidents/trigger", async (req, res): Promise<void> => {
  const parsed = TriggerIncidentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { alertText, simulateCrash } = parsed.data;
  const incident = await getOrCreateIncident(alertText);

  req.log.info(
    { incidentId: incident.incidentId, status: incident.status },
    "Incident triggered",
  );

  const alreadyTerminal = incident.status === "RESOLVED" || incident.status === "FAILED";

  if (!alreadyTerminal && incident.status !== "PENDING_APPROVAL") {
    const embedding = pseudoEmbedding(alertText);
    const similar = await findSimilarIncident(embedding);
    if (similar) {
      req.log.info(
        { distance: similar.distance, strategy: similar.strategyName },
        "Found similar historical incident via RAG lookup",
      );
    }
  }

  const result = await runAgentLoop(incident, alertText, simulateCrash);
  res.json(TriggerIncidentResponse.parse(result));
});

// ── Approbation / rejet humain (Couche 2) ────────────────────────────────

/**
 * Approuve un incident en attente (PENDING_APPROVAL).
 * Change le routingMode en AUTONOMOUS, réinitialise le statut pour permettre
 * la reprise, puis relance la boucle d'agent de façon asynchrone.
 */
router.post("/incidents/:incidentId/approve", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const incident = await getIncidentById(params.data.incidentId);
  if (!incident) {
    res.status(404).json({ error: "Incident not found" });
    return;
  }

  if (incident.status !== "PENDING_APPROVAL") {
    res.status(409).json({
      error: `Incident is in status '${incident.status}', expected 'PENDING_APPROVAL'`,
    });
    return;
  }

  const context = incident.contextJson as IncidentContext;
  // L'humain approuve : on remplace le mode par AUTONOMOUS pour que le
  // Remediator procède sans nouvelle vérification.
  context.routingMode = "AUTONOMOUS";

  const [updated] = await db
    .update(incidentStateTable)
    .set({
      status: "DIAGNOSING",        // statut qui permet la reprise
      currentStep: "HUMAN_APPROVED",
      claimedByAgent: null,        // libérer au cas où un agent avait réclamé
      contextJson: context,
    })
    .where(eq(incidentStateTable.incidentId, incident.incidentId))
    .returning();

  req.log.info({ incidentId: incident.incidentId }, "Incident approved by human");

  // Réponse immédiate, puis reprise asynchrone de la boucle
  res.json({ status: "approved", incidentId: incident.incidentId });

  const alertText = (context.alertText as string | undefined) ?? "";
  runAgentLoop(updated, alertText, false).catch((err: unknown) => {
    req.log.error({ err, incidentId: incident.incidentId }, "Async agent loop after approval failed");
  });
});

/**
 * Rejette un incident en attente (PENDING_APPROVAL).
 * Marque l'incident comme FAILED et indexe le résultat négatif dans la mémoire
 * vectorielle — le win-rate de la stratégie sera ajusté à la baisse.
 */
router.post("/incidents/:incidentId/reject", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const incident = await getIncidentById(params.data.incidentId);
  if (!incident) {
    res.status(404).json({ error: "Incident not found" });
    return;
  }

  if (incident.status !== "PENDING_APPROVAL") {
    res.status(409).json({
      error: `Incident is in status '${incident.status}', expected 'PENDING_APPROVAL'`,
    });
    return;
  }

  const context = incident.contextJson as IncidentContext;
  context.routingMode = "REJECTED";
  context.finalResponse = `FAILED [rejeté par l'humain]: L'opérateur a décidé de ne pas appliquer la stratégie '${context.strategyName ?? "unknown"}'. Incident clôturé sans action corrective.`;

  const [updated] = await db
    .update(incidentStateTable)
    .set({
      status: "FAILED",
      currentStep: "HUMAN_REJECTED",
      claimedByAgent: null,
      contextJson: context,
      resolvedAt: new Date(),
      // Un rejet humain consomme moins de RU qu'un incident complet
      // (1 diagnostic + routage + rejet = ~25 RU)
      ruConsumed: 25,
    })
    .where(eq(incidentStateTable.incidentId, incident.incidentId))
    .returning();

  req.log.info({ incidentId: incident.incidentId }, "Incident rejected by human");

  // Indexer le résultat négatif pour ajuster le win-rate (Couche 1)
  const { db: dbModule, incidentVectorsTable } = await import("@workspace/db");
  const alertText = (context.alertText as string | undefined) ?? "";
  if (alertText && context.strategyName) {
    await dbModule.insert(incidentVectorsTable).values({
      incidentId: incident.incidentId,
      errorMessageText: alertText,
      embedding: pseudoEmbedding(alertText),
      strategyName: context.strategyName,
      outcomeSuccess: false, // rejet = signal négatif pour cette stratégie
    });
  }

  res.json(GetIncidentResponse.parse(updated));
});

// ── Chaîne causale (CTE récursive) ───────────────────────────────────────

/**
 * Remonte la chaîne causale d'un incident via une CTE récursive CockroachDB.
 * Un incident B causé par les effets de bord de la réparation de A est
 * retrouvé par WITH RECURSIVE — ce qu'un simple vector store ne peut pas
 * faire.
 */
router.get("/incidents/:incidentId/causal-chain", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { incidentId } = params.data;

  const rows = await db.execute<{
    incident_id: string;
    alert_fingerprint: string;
    status: string;
    current_step: string | null;
    caused_by_incident_id: string | null;
    updated_at: string;
    depth: number;
  }>(sql`
    WITH RECURSIVE causal_chain AS (
      -- Ancre : l'incident demandé
      SELECT
        incident_id, alert_fingerprint, status, current_step,
        caused_by_incident_id, updated_at, 0 AS depth
      FROM incident_state
      WHERE incident_id = ${incidentId}

      UNION ALL

      -- Récursion : remonter vers les incidents parents
      SELECT
        p.incident_id, p.alert_fingerprint, p.status, p.current_step,
        p.caused_by_incident_id, p.updated_at, c.depth + 1
      FROM incident_state p
      JOIN causal_chain c ON p.incident_id = c.caused_by_incident_id
      WHERE c.depth < 10
    )
    SELECT * FROM causal_chain ORDER BY depth DESC
  `);

  res.json({
    incidentId,
    chain: rows.rows.map((r) => ({
      incidentId: r.incident_id,
      alertFingerprint: r.alert_fingerprint,
      status: r.status,
      currentStep: r.current_step,
      causedByIncidentId: r.caused_by_incident_id,
      updatedAt: r.updated_at,
      depth: r.depth,
    })),
    note: "Chaîne causale remontée par CTE récursive (WITH RECURSIVE) — fonctionnalité SQL native CockroachDB.",
  });
});

// ── Handoffs d'un incident ────────────────────────────────────────────────

router.get("/incidents/:incidentId/handoffs", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const handoffs = await getIncidentHandoffs(params.data.incidentId);
  res.json(handoffs.map((h) => ({
    handoffId: h.handoffId,
    incidentId: h.incidentId,
    agentName: h.agentName,
    decisionMode: h.decisionMode,
    note: h.note,
    createdAt: h.createdAt,
  })));
});

// ── Liste / détail ────────────────────────────────────────────────────────

router.get("/incidents", async (_req, res): Promise<void> => {
  const incidents = await db
    .select()
    .from(incidentStateTable)
    .orderBy(desc(incidentStateTable.updatedAt))
    .limit(50);

  res.json(ListIncidentsResponse.parse(incidents));
});

router.get("/incidents/:incidentId", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const incident = await getIncidentById(params.data.incidentId);
  if (!incident) {
    res.status(404).json({ error: "Incident not found" });
    return;
  }

  res.json(GetIncidentResponse.parse(incident));
});

// ── Logs d'exécution ─────────────────────────────────────────────────────

router.get("/logs", async (req, res): Promise<void> => {
  const query = ListExecutionLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = query.data.incidentId
    ? await db
        .select()
        .from(executionLogsTable)
        .where(eq(executionLogsTable.incidentId, query.data.incidentId))
        .orderBy(desc(executionLogsTable.createdAt))
        .limit(100)
    : await db
        .select()
        .from(executionLogsTable)
        .orderBy(desc(executionLogsTable.createdAt))
        .limit(100);

  res.json(ListExecutionLogsResponse.parse(rows));
});

// ── Handoffs globaux ──────────────────────────────────────────────────────

router.get("/handoffs", async (_req, res): Promise<void> => {
  const { asc } = await import("drizzle-orm");
  const handoffs = await db
    .select()
    .from(agentHandoffsTable)
    .orderBy(asc(agentHandoffsTable.createdAt))
    .limit(200);

  res.json(handoffs.map((h) => ({
    handoffId: h.handoffId,
    incidentId: h.incidentId,
    agentName: h.agentName,
    decisionMode: h.decisionMode,
    note: h.note,
    createdAt: h.createdAt,
  })));
});

export default router;

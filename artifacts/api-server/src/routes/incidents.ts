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
  recordHumanFeedback,
  runAgentLoop,
  type IncidentContext,
} from "../lib/cloud-surgeon";
import { generateEmbedding } from "../lib/embeddings";
import { sanitizeAlertText, validateAlertText } from "../lib/prompt-guard";
import { createChaosConfig } from "../lib/chaos";
import { apiKeyAuth } from "../middleware/apiKeyAuth";

const router: IRouter = Router();

// All incident/log routes require the shared API key with the
// dashboard — see middleware/apiKeyAuth.ts.
router.use(apiKeyAuth);

// ── Trigger / resume ──────────────────────────────────────────────────────

router.post("/incidents/trigger", async (req, res): Promise<void> => {
  const parsed = TriggerIncidentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { alertText: rawAlertText, simulateCrash } = parsed.data;

  // ── Prompt injection defense (Layer 0) ─────────────────────────────────
  // Validate before any DB write to avoid creating incidents from malicious input.
  const validation = validateAlertText(rawAlertText);
  if (!validation.ok) {
    req.log.warn({ reason: validation.error }, "Prompt injection guard: hard-rejected input");
    res.status(400).json({ error: `Invalid alertText: ${validation.error}` });
    return;
  }

  const guard = sanitizeAlertText(rawAlertText);
  if (guard.injectionDetected) {
    req.log.warn(
      { reasons: guard.reasons, original: rawAlertText.slice(0, 200) },
      "Prompt injection guard: injection patterns detected — text sanitized before LLM injection",
    );
  }

  const alertText = guard.sanitized;
  // ──────────────────────────────────────────────────────────────────────

  const incident = await getOrCreateIncident(alertText);

  req.log.info(
    { incidentId: incident.incidentId, status: incident.status },
    "Incident triggered",
  );

  // Log the injection attempt to execution_logs so the dashboard journal shows it.
  if (guard.injectionDetected) {
    const { db: dbMod, executionLogsTable: logsTable } = await import("@workspace/db");
    await dbMod.insert(logsTable).values({
      incidentId: incident.incidentId,
      actionTaken: "INJECTION_BLOCKED",
      result: JSON.stringify({
        reasons: guard.reasons,
        sanitizedText: alertText.slice(0, 200),
        originalLength: rawAlertText.length,
      }),
    }).catch(() => { /* best-effort — don't fail the request */ });
  }

  const alreadyTerminal = incident.status === "RESOLVED" || incident.status === "FAILED";

  if (!alreadyTerminal && incident.status !== "PENDING_APPROVAL") {
    const { embedding } = await generateEmbedding(alertText);
    const similar = await findSimilarIncident(embedding);
    if (similar) {
      req.log.info(
        { distance: similar.distance, strategy: similar.strategyName },
        "Found similar historical incident via RAG lookup",
      );
    }
  }

  // chaosMode is an extension beyond the generated schema — read directly from body
  const chaosMode = typeof req.body?.chaosMode === "string" ? req.body.chaosMode : "none";
  const chaosConfig = createChaosConfig(chaosMode);

  if (chaosConfig.mode !== "none") {
    req.log.info({ chaosMode: chaosConfig.mode }, "Chaos engineering mode activated");
  }

  const result = await runAgentLoop(incident, alertText, simulateCrash, chaosConfig);
  res.json(TriggerIncidentResponse.parse(result));
});

// ── Human approval / rejection (Layer 2) ─────────────────────────────────

/**
 * Approves a pending incident (PENDING_APPROVAL).
 * Changes routingMode to AUTONOMOUS, resets status to allow resumption,
 * then asynchronously restarts the agent loop.
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
  // Human approves: replace mode with AUTONOMOUS so the Remediator
  // proceeds without a new validation check.
  context.routingMode = "AUTONOMOUS";

  const [updated] = await db
    .update(incidentStateTable)
    .set({
      status: "DIAGNOSING",        // status that allows resumption
      currentStep: "HUMAN_APPROVED",
      claimedByAgent: null,        // release in case an agent had claimed it
      contextJson: context,
    })
    .where(eq(incidentStateTable.incidentId, incident.incidentId))
    .returning();

  req.log.info({ incidentId: incident.incidentId }, "Incident approved by human");

  // Immediate response, then async loop resumption
  res.json({ status: "approved", incidentId: incident.incidentId });

  const alertText = (context.alertText as string | undefined) ?? "";
  runAgentLoop(updated, alertText, false).catch((err: unknown) => {
    req.log.error({ err, incidentId: incident.incidentId }, "Async agent loop after approval failed");
  });
});

/**
 * Rejects a pending incident (PENDING_APPROVAL).
 * Marks the incident as FAILED and indexes the negative result in vector
 * memory — the strategy win-rate will be adjusted downward.
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
  context.finalResponse = `FAILED [rejected by human]: Operator decided not to apply strategy '${context.strategyName ?? "unknown"}'. Incident closed without corrective action.`;

  const [updated] = await db
    .update(incidentStateTable)
    .set({
      status: "FAILED",
      currentStep: "HUMAN_REJECTED",
      claimedByAgent: null,
      contextJson: context,
      resolvedAt: new Date(),
      // A human rejection consumes fewer RU than a full incident
      // (1 diagnostic + routing + rejection = ~25 RU)
      ruConsumed: 25,
    })
    .where(eq(incidentStateTable.incidentId, incident.incidentId))
    .returning();

  req.log.info({ incidentId: incident.incidentId }, "Incident rejected by human");

  // Record human signal (Layer 2 → Layer 1):
  // Rejection weighs 0.5 instead of 1.0 — memory stays cautious about
  // human judgments compared to a true incident failure.
  const alertText = (context.alertText as string | undefined) ?? "";
  if (alertText && context.strategyName) {
    await recordHumanFeedback(
      incident.incidentId,
      alertText,
      context.strategyName,
      "rejected",
    );
  }

  res.json(GetIncidentResponse.parse(updated));
});

/**
 * Corrects a pending incident (PENDING_APPROVAL) by suggesting an
 * alternative strategy.
 *
 * Layer 2 closes its learning loop here:
 *  - Negative signal (w=0.5) for the original strategy → win-rate decreases
 *  - Positive signal (w=0.5) for the suggested strategy → win-rate increases
 * Both signals are marked `signal_source = "human"` in `incident_vectors`
 * to distinguish human feedback from automatic outcomes.
 */
router.post("/incidents/:incidentId/correct", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const suggestedStrategy =
    typeof req.body?.suggestedStrategy === "string"
      ? req.body.suggestedStrategy.trim()
      : null;

  if (!suggestedStrategy) {
    res.status(400).json({ error: "Missing required field: suggestedStrategy" });
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
  const originalStrategy = context.strategyName ?? "unknown";

  context.routingMode = "REJECTED";
  context.finalResponse =
    `HUMAN_CORRECTED: Operator rejected strategy '${originalStrategy}' ` +
    `and suggested '${suggestedStrategy}'. ` +
    `Both signals integrated into vector memory (human signal, weight 0.5). ` +
    `Win-rate for '${originalStrategy}' decreased; win-rate for '${suggestedStrategy}' increased.`;

  const [updated] = await db
    .update(incidentStateTable)
    .set({
      status: "FAILED",
      currentStep: "HUMAN_CORRECTED",
      claimedByAgent: null,
      contextJson: context,
      resolvedAt: new Date(),
      ruConsumed: 25,
    })
    .where(eq(incidentStateTable.incidentId, incident.incidentId))
    .returning();

  req.log.info(
    { incidentId: incident.incidentId, originalStrategy, suggestedStrategy },
    "Incident corrected by human — updating win-rates for both strategies",
  );

  const alertText = (context.alertText as string | undefined) ?? "";
  if (alertText) {
    await recordHumanFeedback(
      incident.incidentId,
      alertText,
      originalStrategy,
      "corrected",
      suggestedStrategy,
    );
  }

  res.json(GetIncidentResponse.parse(updated));
});

// ── Causal chain (recursive CTE) ─────────────────────────────────────────

/**
 * Walks the causal chain of an incident via a CockroachDB recursive CTE.
 * An incident B caused by side effects of repairing A is found by
 * WITH RECURSIVE — something a simple vector store cannot do.
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
      -- Anchor: the requested incident
      SELECT
        incident_id, alert_fingerprint, status, current_step,
        caused_by_incident_id, updated_at, 0 AS depth
      FROM incident_state
      WHERE incident_id = ${incidentId}

      UNION ALL

      -- Recursion: walk up to parent incidents
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
    note: "Causal chain walked via recursive CTE (WITH RECURSIVE) — native CockroachDB SQL feature.",
  });
});

// ── Incident handoffs ─────────────────────────────────────────────────────

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

// ── List / detail ─────────────────────────────────────────────────────────

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

// ── Execution logs ────────────────────────────────────────────────────────

/**
 * GET /logs/count
 * Returns the true total row count from CockroachDB, unaffected by pagination.
 * Optional query param: incidentId — scopes the count to one incident.
 */
router.get("/logs/count", async (req, res): Promise<void> => {
  const query = ListExecutionLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const [row] = query.data.incidentId
    ? await db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(executionLogsTable)
        .where(eq(executionLogsTable.incidentId, query.data.incidentId))
    : await db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(executionLogsTable);

  res.json({ count: row?.count ?? 0 });
});

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

// ── Global handoffs ───────────────────────────────────────────────────────

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

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
  releaseIncidentClaim,
  runAgentLoop,
  runRollbackLoop,
  type IncidentContext,
} from "../lib/cloud-surgeon";
import { generateEmbedding } from "../lib/embeddings";
import { sanitizeAlertText, validateAlertText } from "../lib/prompt-guard";
import { createChaosConfig } from "../lib/chaos";
import { apiKeyAuth } from "../middleware/apiKeyAuth";

const router: IRouter = Router();

/** Serialize Date fields to ISO strings so Zod z.string() schemas don't throw. */
function serializeDates<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(serializeDates) as unknown as T;
  if (obj instanceof Date) return obj.toISOString() as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = serializeDates(v);
    return out as unknown as T;
  }
  return obj;
}

/**
 * Promote key contextJson fields to top-level so the dashboard doesn't have
 * to drill into the opaque contextJson blob for common display fields.
 * alertText, strategyName, routingMode etc. live inside contextJson in the DB
 * but the API contract exposes them as first-class incident properties.
 */
function flattenIncident(incident: Record<string, unknown>): Record<string, unknown> {
  const ctx = (incident.contextJson ?? {}) as Record<string, unknown>;
  return {
    ...incident,
    alertText:       (ctx.alertText       as string  | undefined) ?? null,
    strategyName:    (ctx.strategyName    as string  | undefined) ?? null,
    routingMode:     (ctx.routingMode     as string  | undefined) ?? null,
    auditVerdict:    (ctx.auditVerdict    as string  | undefined) ?? null,
    effectiveWinRate:(ctx.effectiveWinRate as number | undefined) ?? null,
    winRate:         (ctx.winRate         as number  | undefined) ?? null,
    repairSuccess:   (ctx.repairSuccess   as boolean | undefined) ?? null,
    finalResponse:   (ctx.finalResponse   as string  | undefined) ?? null,
    repairPlan:      (ctx.repairPlan      as unknown | undefined) ?? null,
    rollbackInfo:    (ctx.rollbackInfo    as unknown | undefined) ?? null,
  };
}

/**
 * Known valid strategy names — kept in sync with STRATEGY_PLANS in
 * repair-strategies.ts and the alert_patterns in cloud-surgeon.config.yaml.
 * Used to validate human-provided strategy names before writing them to
 * incident_vectors (prevents RAG memory corruption via arbitrary strings).
 */
const VALID_STRATEGIES = new Set([
  "ecs_service_restart", "rds_cpu_throttle", "lambda_concurrency_scale",
  "jvm_heap_restart", "db_connection_pool_reset", "network_route_failover",
  "iam_credential_rotation", "external_dependency_circuit_break", "disk_cleanup",
  "cloudwatch_alarm_triage", "default_repair",
  "crdb_hotspot_resolution", "crdb_index_optimization", "crdb_slow_query_termination",
  "crdb_replication_recovery", "crdb_changefeed_restart",
]);

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
  res.json(TriggerIncidentResponse.parse(serializeDates(result)));
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
  // Preserve the original routing decision before granting autonomy so the
  // Decision Trace can display "PENDING_APPROVAL → human approved → AUTONOMOUS"
  // rather than erasing the approval from history.
  context.originalRoutingMode = context.routingMode;   // "PENDING_APPROVAL"
  context.humanApproved       = true;
  context.approvedAt          = new Date().toISOString();
  context.routingMode         = "AUTONOMOUS";

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
  context.originalRoutingMode = context.routingMode;   // preserve "PENDING_APPROVAL"
  context.humanApproved       = false;
  context.rejectedAt          = new Date().toISOString();
  context.routingMode         = "REJECTED";
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

  res.json(GetIncidentResponse.parse(serializeDates(updated)));
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

  // Whitelist check — prevent arbitrary strings from polluting incident_vectors RAG memory.
  if (!VALID_STRATEGIES.has(suggestedStrategy)) {
    res.status(400).json({
      error: `Unknown strategy '${suggestedStrategy}'. Valid strategies: ${[...VALID_STRATEGIES].sort().join(", ")}`,
    });
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

  context.originalRoutingMode  = context.routingMode;   // preserve "PENDING_APPROVAL"
  context.humanApproved        = false;
  context.rejectedAt           = new Date().toISOString();
  context.correctedStrategy    = suggestedStrategy;      // operator's suggested alternative
  context.routingMode          = "REJECTED";
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

  res.json(GetIncidentResponse.parse(serializeDates(updated)));
});

// ── Manual retry ─────────────────────────────────────────────────────────

/**
 * Force-retries a stuck incident.
 *
 * Any incident in TRIGGERED or DIAGNOSING that got orphaned mid-loop
 * (agent crashed without releasing its claim, or the server restarted
 * before the loop reached a terminal state) can be unblocked here.
 *
 * Steps:
 *   1. Validate the incident exists and is not already terminal.
 *   2. Force-release any orphaned agent claim.
 *   3. Re-run the agent loop asynchronously.
 *   4. Return immediately so the dashboard can poll for progress.
 */
router.post("/incidents/:incidentId/retry", async (req, res): Promise<void> => {
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

  const terminal = incident.status === "RESOLVED" || incident.status === "FAILED";
  if (terminal) {
    res.status(409).json({
      error: `Incident is already terminal (status: '${incident.status}') — cannot retry.`,
    });
    return;
  }

  if (incident.status === "PENDING_APPROVAL") {
    res.status(409).json({
      error: "Incident is awaiting human approval — use /approve or /reject instead.",
    });
    return;
  }

  // Release any stale agent claim so the loop can re-enter each phase.
  await releaseIncidentClaim(incident.incidentId);

  const context = incident.contextJson as IncidentContext | null;
  const alertText =
    (context?.alertText as string | undefined) ??
    "Unknown alert — retried manually";

  req.log.info(
    { incidentId: incident.incidentId, status: incident.status, alertText: alertText.slice(0, 80) },
    "[RETRY] Force-retrying stuck incident",
  );

  // Return immediately; loop runs in background.
  res.json({
    status: "retrying",
    incidentId: incident.incidentId,
    previousStatus: incident.status,
    alertText: alertText.slice(0, 120),
  });

  runAgentLoop(incident, alertText, false).catch((err: unknown) => {
    req.log.error({ err, incidentId: incident.incidentId }, "[RETRY] Agent loop failed after manual retry");
  });
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

// ── Playbook for incident (Feature 1: Explainable AI) ─────────────────────

router.get("/incidents/:incidentId/playbook", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { incidentId } = params.data;
  const rows = await db.execute<{
    playbook_id: string; incident_id: string; strategy_name: string;
    title: string; content_md: string; generated_by: string; created_at: string;
  }>(sql`
    SELECT playbook_id, incident_id, strategy_name, title, content_md, generated_by, created_at
    FROM   playbooks
    WHERE  incident_id = ${incidentId}
    LIMIT  1
  `);
  if (rows.rows.length === 0) {
    // Return 200+null (not 404) so the dashboard stops polling with errors.
    // A missing playbook is normal for in-progress or failed incidents.
    res.status(200).json(null);
    return;
  }
  const r = rows.rows[0];
  res.json({
    playbookId: r.playbook_id, incidentId: r.incident_id, strategyName: r.strategy_name,
    title: r.title, contentMd: r.content_md, generatedBy: r.generated_by, createdAt: r.created_at,
  });
});

// ── Rollback plan for incident (Feature 3: Rollback Policy) ───────────────

router.get("/incidents/:incidentId/rollback-plan", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { incidentId } = params.data;
  const rows = await db.execute<{
    rollback_id: string; incident_id: string; strategy_name: string;
    pre_repair_state: unknown; executed_commands: string; rollback_steps: string;
    estimated_rollback_time: string | null; risk_level: string; created_at: string;
  }>(sql`
    SELECT rollback_id, incident_id, strategy_name, pre_repair_state, executed_commands,
           rollback_steps, estimated_rollback_time, risk_level, created_at
    FROM   rollback_plans
    WHERE  incident_id = ${incidentId}
    LIMIT  1
  `);
  if (rows.rows.length === 0) {
    // Return 200+null so the dashboard doesn't log console errors for in-progress incidents.
    res.status(200).json(null);
    return;
  }
  const r = rows.rows[0];
  res.json({
    rollbackId: r.rollback_id, incidentId: r.incident_id, strategyName: r.strategy_name,
    preRepairState: r.pre_repair_state, executedCommands: r.executed_commands,
    rollbackSteps: r.rollback_steps, estimatedRollbackTime: r.estimated_rollback_time,
    riskLevel: r.risk_level, createdAt: r.created_at,
  });
});

// ── Human-triggered rollback ──────────────────────────────────────────────
//
// POST /api/incidents/:incidentId/rollback
//
// Reads the rollback plan generated during the Remediator phase and executes
// the inverse AWS action (force-new-deployment, restore Lambda concurrency,
// restore RDS parameter group).  Only allowed when incident status is
// RESOLVED, FAILED, or PENDING_APPROVAL (i.e. repair phase has started).

router.post("/incidents/:incidentId/rollback", async (req, res): Promise<void> => {
  const params = GetIncidentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { incidentId } = params.data;

  // Guard: only rollback incidents that have passed the Remediator phase
  const incident = await getIncidentById(incidentId);
  if (!incident) {
    res.status(404).json({ error: "Incident not found" });
    return;
  }
  const allowedStatuses = ["RESOLVED", "FAILED", "PENDING_APPROVAL", "REPAIRING"];
  if (!allowedStatuses.includes(incident.status)) {
    res.status(409).json({
      error: `Cannot rollback — incident status is '${incident.status}'. ` +
             `Rollback is only available after the repair phase has started.`,
    });
    return;
  }
  if (incident.status === "ROLLED_BACK") {
    res.status(409).json({ error: "Incident has already been rolled back." });
    return;
  }

  const rollbackOutcome = await runRollbackLoop(incidentId);
  res.status(rollbackOutcome.success ? 200 : 500).json(rollbackOutcome);
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

router.get("/incidents", async (req, res): Promise<void> => {
  // Support ?limit= and ?offset= for pagination.
  // Default 50, max 200 per request to keep responses manageable.
  const limit  = Math.min(Math.max(Number(req.query.limit)  || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const incidents = await db
    .select()
    .from(incidentStateTable)
    .orderBy(desc(incidentStateTable.updatedAt))
    .limit(limit)
    .offset(offset);

  // Do not run through ListIncidentsResponse.parse() — the generated Zod schema
  // does not include triggeredAt / resolvedAt, so .parse() silently strips them.
  // The data comes from the DB (trusted), so validation is not needed here.
  // flattenIncident promotes key contextJson fields (alertText, strategyName …)
  // to top-level so the dashboard can read them without drilling into contextJson.
  const flat = (serializeDates(incidents) as unknown as Record<string, unknown>[])
    .map(flattenIncident);
  res.json(flat);
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

  // Do not run through GetIncidentResponse.parse() — the generated Zod schema
  // does not include triggeredAt / resolvedAt, so .parse() silently strips them.
  // flattenIncident promotes contextJson fields to top-level (alertText, strategyName …).
  res.json(flattenIncident(serializeDates(incident) as unknown as Record<string, unknown>));
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

  res.json(ListExecutionLogsResponse.parse(serializeDates(rows)));
});

// ── Global handoffs ───────────────────────────────────────────────────────

router.get("/handoffs", async (req, res): Promise<void> => {
  const { asc, eq } = await import("drizzle-orm");
  const incidentId = req.query.incidentId as string | undefined;
  const query = db
    .select()
    .from(agentHandoffsTable)
    .orderBy(asc(agentHandoffsTable.createdAt))
    .limit(500);

  const handoffs = incidentId
    ? await db.select().from(agentHandoffsTable)
        .where(eq(agentHandoffsTable.incidentId, incidentId))
        .orderBy(asc(agentHandoffsTable.createdAt))
        .limit(500)
    : await query;

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

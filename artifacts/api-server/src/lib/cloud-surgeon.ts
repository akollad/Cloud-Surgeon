// ============================================================================
// Cloud-Surgeon — Main Agent Loop
//
// This file contains only the three-phase agent loop (Diagnostician →
// Remediator → Auditor) and the rollback loop, plus the CRUD helpers and
// internal persistence utilities they depend on.
//
// Business logic has been extracted into focused modules:
//   agent-types.ts       — shared TypeScript types
//   memory.ts            — Layer 1 vector RAG, strategy/service detection
//   calibration.ts       — Layer 1/2 calibration, routing, human feedback
//   repair-strategies.ts — repair plans, rollback policy, AI playbooks
//   coordination.ts      — Layer 3 multi-agent locking via serializable txns
//
// All public exports from those modules are re-exported here so existing
// route importers do not need to change.
// ============================================================================

import { eq } from "drizzle-orm";
import {
  db,
  pool,
  incidentStateTable,
  agentHandoffsTable,
  executionLogsTable,
  type IncidentState,
} from "@workspace/db";
import { callMcpTool } from "../mcp/client";
import { invokeLLMThought } from "./llm";
import { generateEmbedding } from "./embeddings";
import { type ChaosConfig, ChaosPartitionError, injectChaos, sleep as chaosSleep } from "./chaos";

// ── Sub-module imports ────────────────────────────────────────────────────

import {
  fingerprint,
  detectStrategy,
  detectServiceName,
  getStrategyWinRate,
  getAllStrategyWinRates,
  findSimilarIncident,
  detectIncidentStorm,
} from "./memory";

import {
  indexResolvedIncident,
  recordRoutingPrediction,
  recalibrateStrategy,
  getCorrectionFactor,
  recalibrateAllStrategies,
  recordHumanFeedback,
  getAllCalibrationData,
  computeRoutingMode,
} from "./calibration";

import {
  generateRepairPlan,
  generateAndStoreRollbackPlan,
  createRollbackPlansTable,
  generateAndStorePlaybook,
} from "./repair-strategies";

import {
  claimIncidentForAgent,
  releaseIncidentClaim,
  logAgentHandoff,
  BASE_RU_PER_INCIDENT,
  estimateRuConsumed,
} from "./coordination";

// ── Re-exports for backward compat with existing route importers ──────────
export type {
  RoutingMode,
  AgentName,
  AgentTurn,
  RepairPlan,
  RollbackInfo,
  IncidentContext,
} from "./agent-types";
export type { HumanFeedback, CalibrationStatus, CalibrationRow } from "./calibration";

export {
  fingerprint,
  detectStrategy,
  detectServiceName,
  getStrategyWinRate,
  getAllStrategyWinRates,
  findSimilarIncident,
  detectIncidentStorm,
  indexResolvedIncident,
  recordRoutingPrediction,
  recalibrateStrategy,
  getCorrectionFactor,
  recalibrateAllStrategies,
  recordHumanFeedback,
  getAllCalibrationData,
  computeRoutingMode,
  generateRepairPlan,
  generateAndStoreRollbackPlan,
  createRollbackPlansTable,
  generateAndStorePlaybook,
  claimIncidentForAgent,
  releaseIncidentClaim,
  logAgentHandoff,
  BASE_RU_PER_INCIDENT,
  estimateRuConsumed,
};

// ── Types (local) ─────────────────────────────────────────────────────────
import type { AgentName, IncidentContext, AgentTurn } from "./agent-types";

// ── Internal utilities ────────────────────────────────────────────────────

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

/** Returns true when the alert is DB / CockroachDB / connection related. */
function isDbRelatedAlert(alertText: string): boolean {
  const t = alertText.toLowerCase();
  return (
    t.includes("rds") ||
    t.includes("postgres") ||
    t.includes("mysql") ||
    t.includes("max_connections") ||
    t.includes("connection pool") ||
    t.includes("pg_stat") ||
    t.includes("database") ||
    t.includes("cockroach") ||
    t.includes("crdb") ||
    t.includes("db cpu") ||
    t.includes("db latency")
  );
}

async function callTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (toolName === "execute_ccloud_command") {
    const action =
      (toolInput.action as string | undefined) ??
      (() => { try { return JSON.parse(String(toolInput.commandJson)).action; } catch { return undefined; } })() ??
      "cluster:status";
    return callMcpTool(toolName, { action });
  }
  if (toolName === "aws_repair_service") return callMcpTool(toolName, toolInput);
  if (toolName === "crdb_cluster_health") return callMcpTool(toolName, {});
  if (toolName === "crdb_list_slow_queries") return callMcpTool(toolName, toolInput);
  if (toolName === "crdb_query") return callMcpTool(toolName, toolInput);
  if (toolName === "crdb_diagnose_hotspots") return callMcpTool(toolName, toolInput);
  if (toolName === "crdb_index_advisor") return callMcpTool(toolName, toolInput);
  if (toolName === "crdb_cancel_query") return callMcpTool(toolName, toolInput);
  if (toolName === "crdb_job_status") return callMcpTool(toolName, toolInput);
  if (toolName === "crdb_skill_repair") return callMcpTool(toolName, toolInput);
  if (toolName === "rollback_service") return callMcpTool(toolName, toolInput);

  if (toolName === "verify_resolution") {
    const repairVerified  = Boolean(toolInput.repairVerified);
    const actionPerformed = Boolean(toolInput.actionPerformed);

    const describeActions = new Set([
      "DESCRIBE_FUNCTION",
      "DESCRIBE_FUNCTION_CONCURRENCY",
      "DESCRIBE_SERVICES",
      "DESCRIBE_DB_INSTANCES",
      "AWS_API_CALL",
    ]);
    const actionTaken = String(toolInput.actionTaken ?? "");
    const isDescribeOnly = !actionPerformed || describeActions.has(actionTaken);

    let verdict: string;
    let verified: boolean;
    let message: string;

    if (!repairVerified) {
      verdict  = "FAIL";
      verified = false;
      message  = "Repair output indicates failure. Escalation to on-call team recommended.";
    } else if (isDescribeOnly) {
      verdict  = "NO_ACTION_REQUIRED";
      verified = true;
      message  =
        `No infrastructure change was made (${actionTaken || "describe only"}). ` +
        "Service state confirmed healthy — no repair action was necessary. " +
        "If throttling persists, a quota increase via AWS Support may be required.";
    } else {
      verdict  = "PASS";
      verified = true;
      message  = `Repair action confirmed (${actionTaken}). Incident can be closed.`;
    }

    return {
      verified, verdict, actionPerformed, actionTaken,
      auditTime: new Date().toISOString(),
      strategyUsed: toolInput.strategyUsed,
      message,
    };
  }
  return { success: false, error: `Unknown tool: ${toolName}` };
}

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
        await logExecution(
          incidentId,
          "CHAOS_INJECTED",
          JSON.stringify({
            mode: "latency", phase: phaseName, delayMs: event.delayMs, wasPartition: false,
            message: `Simulated network latency: ${event.delayMs} ms added before DB write (${phaseName})`,
          }),
        );
      }
    } catch (err) {
      if (err instanceof ChaosPartitionError) {
        await logExecution(
          incidentId,
          "CHAOS_INJECTED",
          JSON.stringify({
            mode: "partition", phase: phaseName, wasPartition: true,
            error: (err as Error).message,
            recovery: "auto-retry after 500ms — previous phase state intact in DB",
            message: `Simulated partition (${phaseName}): DB write aborted. The state persisted in the previous phase is intact in CockroachDB. Automatic recovery in 500 ms.`,
          }),
        );
        await sleep(500);
        return persistIncidentState(incidentId, status, currentStep, context, opts);
      }
      throw err;
    }
  }

  return persistIncidentState(incidentId, status, currentStep, context, opts);
}

async function persistIncidentState(
  incidentId: string,
  status: string,
  currentStep: string,
  context: IncidentContext,
  opts?: { resolvedAt?: Date; ruConsumed?: number },
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

// ── Basic CRUD ────────────────────────────────────────────────────────────

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

// ── Main agent loop ───────────────────────────────────────────────────────

/**
 * Executes or resumes the agent loop in 3 phases (Diagnostician → Remediator
 * → Auditor). Each phase claims the incident via a CockroachDB serializable
 * transaction, writes its turn to the DB, then releases the claim — the loop
 * can be interrupted at any time and resumes exactly where it left off on
 * the next call.
 */
export async function runAgentLoop(
  incident: IncidentState,
  alertText: string,
  simulateCrash: boolean,
  chaos?: ChaosConfig,
): Promise<IncidentState> {
  if (incident.status === "RESOLVED" || incident.status === "FAILED") return incident;
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
    if (!claimed) return current;

    const alertLower = alertText.toLowerCase();
    const isCrdbDiag =
      strategyName.startsWith("crdb_") ||
      alertLower.includes("cockroach") ||
      alertLower.includes("crdb") ||
      alertLower.includes("hot range") ||
      alertLower.includes("changefeed") ||
      alertLower.includes("under-replicated");
    const isRdsDiag =
      !isCrdbDiag &&
      (strategyName === "rds_cpu_throttle" ||
        alertLower.includes("rds") ||
        (alertLower.includes("database") && !alertLower.includes("connection pool")));
    const isLambdaDiag = strategyName === "lambda_concurrency_scale";
    const isExternalDiag = strategyName === "external_dependency_circuit_break";

    const diagServiceName = detectServiceName(alertText);

    let diagToolName: string;
    let toolInput: Record<string, unknown>;
    if (isCrdbDiag) {
      diagToolName = "crdb_cluster_health";
      toolInput = {};
    } else if (isRdsDiag) {
      diagToolName = "aws_repair_service";
      toolInput = { serviceName: diagServiceName, action: "rds:diagnose" };
    } else if (isExternalDiag) {
      diagToolName = "execute_ccloud_command";
      toolInput = { action: "cluster:status" };
    } else if (isLambdaDiag) {
      diagToolName = "aws_repair_service";
      toolInput = { serviceName: diagServiceName, action: "lambda:diagnose" };
    } else {
      diagToolName = "aws_repair_service";
      toolInput = { serviceName: diagServiceName, action: "ecs:diagnose" };
    }

    const diagNote =
      diagToolName === "execute_ccloud_command"
        ? "Starting diagnostic phase — verifying cluster state via CockroachDB Cloud CLI (ccloud)"
        : diagToolName === "crdb_cluster_health"
        ? "Starting diagnostic phase — querying CockroachDB cluster health directly"
        : diagToolName === "aws_repair_service" && (toolInput.action as string)?.startsWith("rds:")
        ? "Starting diagnostic phase — inspecting RDS instance via AWS API"
        : diagToolName === "aws_repair_service" && (toolInput.action as string)?.startsWith("lambda:")
        ? "Starting diagnostic phase — inspecting Lambda function via AWS API"
        : "Starting diagnostic phase — inspecting ECS service via AWS API";

    await logAgentHandoff(incident.incidentId, "diagnostician", null, diagNote);

    const { thought, source: thoughtSource } = await invokeLLMThought(alertText, 0, null, { strategyName });
    const toolOutput = await callTool(diagToolName, toolInput);

    await logExecution(
      incident.incidentId,
      `${diagToolName}(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: 0, agent: "diagnostician", thought, thoughtSource,
      toolName: diagToolName, toolInput, toolOutput,
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
  // LAYER 2 — Routing decision (between Diagnostician and Remediator)
  // ════════════════════════════════════════════════════════════
  if (context.turns.length === 1 && !context.routingDecisionComputed) {
    const { embedding } = await generateEmbedding(`${alertText} | strategy:${strategyName}`);
    const ragHit = await findSimilarIncident(embedding);
    const winRateResult = await getStrategyWinRate(strategyName);

    await recordRoutingPrediction(strategyName, winRateResult.winRate);
    const correctionFactor = await getCorrectionFactor(strategyName);
    const effectiveWinRate = winRateResult.winRate * correctionFactor;

    const stormDetected = Boolean((context as Record<string, unknown>).stormDetected);
    const routingMode = stormDetected
      ? ("PENDING_APPROVAL" as const)
      : computeRoutingMode(strategyName, ragHit?.distance, effectiveWinRate, winRateResult.count);

    context.routingMode = routingMode;
    context.ragScore = ragHit?.distance ?? null;
    context.ragStrategyHint = ragHit?.strategyName ?? null;
    context.winRate = winRateResult.count > 0 ? winRateResult.winRate : null;
    context.effectiveWinRate = winRateResult.count > 0 ? effectiveWinRate : null;
    context.correctionFactor = correctionFactor !== 1.0 ? correctionFactor : null;
    context.winRateSampleSize = winRateResult.count;
    context.routingDecisionComputed = true;

    if (routingMode === "PENDING_APPROVAL") {
      const stormInfo = stormDetected
        ? `STORM DETECTED (${(context as Record<string, unknown>).stormRelatedCount ?? "?"} related incidents in ${(context as Record<string, unknown>).stormWindowMinutes ?? 10} min window) — autonomous repair disabled`
        : (() => {
            // Show the actual reason PENDING_APPROVAL was chosen, not a generic "low confidence".
            // effectiveWinRate = rawWinRate × correctionFactor and can exceed 1.0 when the
            // strategy outperforms its prediction — cap the displayed value at 100%.
            const cappedPct = Math.min(effectiveWinRate * 100, 100).toFixed(0);
            const pendingReason =
              winRateResult.count < 3
                ? `only ${winRateResult.count} sample(s) in memory — ${3 - winRateResult.count} more needed to unlock autonomous mode`
                : `effective win-rate ${cappedPct}% below the 80% autonomous threshold`;
            return ragHit
              ? `RAG distance: ${ragHit.distance.toFixed(3)}, ${pendingReason} (raw win-rate: ${(winRateResult.winRate * 100).toFixed(0)}%, correction: ×${correctionFactor.toFixed(2)}, ${winRateResult.count} sample(s))`
              : `no RAG match — ${pendingReason}`;
          })();
      await logAgentHandoff(
        incident.incidentId,
        "remediator",
        "PENDING_APPROVAL",
        stormDetected
          ? `Incident storm detected — ${stormInfo}. Awaiting human approval before any repair.`
          : `Routing to PENDING_APPROVAL — ${stormInfo}. Awaiting human approval.`,
      );
      return await persistIncidentState(
        incident.incidentId,
        "PENDING_APPROVAL",
        "AWAITING_HUMAN_APPROVAL",
        context,
      );
    }

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
    const { thought, source: thoughtSource } = await invokeLLMThought(alertText, 1, context.turns[0]?.toolOutput ?? null, { strategyName, serviceName });

    const diagOutput = (context.turns[0]?.toolOutput ?? {}) as Record<string, unknown>;
    const repairPlan = await generateRepairPlan(alertText, strategyName, serviceName, diagOutput);
    context.repairPlan = repairPlan;

    const diagData = (diagOutput.data ?? {}) as Record<string, unknown>;
    const preRepairState: Record<string, unknown> = {
      serviceName, strategy: strategyName, routingMode: context.routingMode,
      capturedAt: new Date().toISOString(),
      desiredCount: diagData.desiredCount,
      runningCount: diagData.runningCount,
      previousTaskDefinition: (diagData.deployments as Array<Record<string, unknown>>)?.[0]?.taskDefinition,
      functionName: diagData.functionName ?? (strategyName === "lambda_concurrency_scale" ? serviceName : undefined),
      originalConcurrency: diagData.previousReservedConcurrency ?? diagData.reservedConcurrency ?? null,
      rdsInstanceId: process.env.RDS_INSTANCE_IDENTIFIER ?? diagData.instanceId,
      originalMaxConnections: diagData.originalMaxConnections ?? diagData.maxConnections,
    };

    const isCrdbStrategy = strategyName.startsWith("crdb_");
    const hasRds = Boolean(process.env.RDS_INSTANCE_IDENTIFIER);
    const isDbStrategy = strategyName === "rds_cpu_throttle" || strategyName === "db_connection_pool_reset";
    const usesCrdbFallback = isDbStrategy && !hasRds;

    const remediatorAction =
      strategyName === "lambda_concurrency_scale"
        ? "lambda:describe_and_remediate"
        : isDbStrategy && hasRds
          ? "rds:describe_and_remediate"
          : "ecs:describe_and_remediate";

    const remediatorToolName =
      isCrdbStrategy ? "crdb_skill_repair"
      : usesCrdbFallback ? "crdb_cluster_health"
      : "aws_repair_service";

    const toolInput =
      isCrdbStrategy ? { strategy: strategyName, serviceName }
      : usesCrdbFallback ? {}
      : { serviceName, action: remediatorAction };

    const toolOutput = await callTool(remediatorToolName, toolInput);

    const rollbackInfo = await generateAndStoreRollbackPlan(
      incident.incidentId, strategyName, toolOutput, preRepairState,
    );
    context.rollbackInfo = rollbackInfo;

    await logExecution(
      incident.incidentId,
      `${remediatorToolName}(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: 1, agent: "remediator", thought, thoughtSource,
      toolName: remediatorToolName, toolInput, toolOutput,
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
      incident.incidentId, "auditor", null,
      "Verifying repair outcome and closing incident. Indexing result in vector memory.",
    );

    const repairOutput = context.turns[1]?.toolOutput as Record<string, unknown>;
    const repairSuccess  = Boolean(repairOutput?.success);
    const repairAction   = String(repairOutput?.actionTaken ?? "");

    const MUTATION_ACTIONS = new Set([
      "PUT_FUNCTION_CONCURRENCY", "UPDATE_SERVICE", "FORCE_NEW_DEPLOYMENT",
      "REBOOT_DB_INSTANCE", "MODIFY_DB_INSTANCE", "RESTORE_DB_PARAMETER_GROUP",
      "CHANGEFEED_RESTART", "CRDB_SKILL_REPAIR",
    ]);
    const actionPerformed = MUTATION_ACTIONS.has(repairAction);

    const toolInput = {
      incidentId: incident.incidentId,
      repairVerified: repairSuccess,
      actionPerformed,
      actionTaken: repairAction,
      strategyUsed: strategyName,
    };
    const { thought, source: thoughtSource } = await invokeLLMThought(alertText, 2, repairOutput ?? null, { strategyName, repairSuccess });
    const toolOutput = await callTool("verify_resolution", toolInput);

    await logExecution(
      incident.incidentId,
      `verify_resolution(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: 2, agent: "auditor", thought, thoughtSource,
      toolName: "verify_resolution", toolInput, toolOutput,
    });

    const finalStatus = repairSuccess ? "RESOLVED" : "FAILED";
    const routingLabel = context.routingMode ?? "AUTONOMOUS";
    const auditVerdict = String((toolOutput as Record<string, unknown>).verdict ?? "PASS");
    context.finalResponse = !repairSuccess
      ? `FAILED [${strategyName}]: Repair failed — escalation to on-call team recommended by Auditor.`
      : auditVerdict === "NO_ACTION_REQUIRED"
        ? `RESOLVED [${strategyName}] [${routingLabel}]: Service confirmed healthy — no repair action was required. ${(toolOutput as Record<string, unknown>).message ?? ""}`
        : `RESOLVED [${strategyName}] [${routingLabel}]: Diagnostic confirmed by Diagnostician, repair applied by Remediator (${repairAction}), closure validated by Auditor.`;

    current = await persistWithChaosRetry(
      incident.incidentId, finalStatus, "FINALIZED", context, chaos, 2,
      { resolvedAt: new Date(), ruConsumed: estimateRuConsumed(context.turns.length) },
    );
    await releaseIncidentClaim(incident.incidentId);

    // Feed Layer 1 with the actual result — auto-calibrates the strategy immediately
    const { embedding: resolvedEmbedding } = await generateEmbedding(`${alertText} | strategy:${strategyName}`);
    await indexResolvedIncident(
      incident.incidentId, alertText, resolvedEmbedding, strategyName, repairSuccess,
    );

    if (repairSuccess) {
      await generateAndStorePlaybook(incident.incidentId, alertText, strategyName, context.turns);
    }
  }

  return current;
}

// ════════════════════════════════════════════════════════════════════════════
// ROLLBACK LOOP — human-triggered reversal of a completed repair
// ════════════════════════════════════════════════════════════════════════════

export async function runRollbackLoop(incidentId: string): Promise<{
  success: boolean;
  result: Record<string, unknown>;
  message: string;
}> {
  const planRows = await pool.query<{
    strategy_name: string;
    pre_repair_state: unknown;
    risk_level: string;
  }>(
    `SELECT strategy_name, pre_repair_state, risk_level
     FROM   rollback_plans
     WHERE  incident_id = $1
     LIMIT  1`,
    [incidentId],
  );

  if (planRows.rows.length === 0) {
    return {
      success: false,
      result: {},
      message: "No rollback plan found — incident may not have reached the Remediator phase yet.",
    };
  }

  const plan = planRows.rows[0];
  const preRepairState =
    typeof plan.pre_repair_state === "string"
      ? (JSON.parse(plan.pre_repair_state) as Record<string, unknown>)
      : (plan.pre_repair_state as Record<string, unknown>);

  const rollbackInput = {
    strategy: plan.strategy_name,
    serviceName: preRepairState.serviceName ?? "unknown",
    preRepairState,
    riskLevel: plan.risk_level,
  };

  const result = await callMcpTool("rollback_service", rollbackInput);
  const success = Boolean(result.success);

  await pool.query(
    `UPDATE rollback_plans
     SET rolled_back_at = now(), rollback_result = $1
     WHERE incident_id = $2`,
    [JSON.stringify(result), incidentId],
  );

  if (success) {
    await pool.query(
      `UPDATE incident_state SET status = 'ROLLED_BACK', updated_at = now() WHERE incident_id = $1`,
      [incidentId],
    );
  }

  return {
    success,
    result,
    message: success
      ? `Rollback completed for strategy '${plan.strategy_name}'.`
      : `Rollback attempted for '${plan.strategy_name}' but returned failure — manual intervention may be required.`,
  };
}

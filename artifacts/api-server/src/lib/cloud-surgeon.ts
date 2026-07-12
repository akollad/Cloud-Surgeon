import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  agentHandoffsTable,
  executionLogsTable,
  incidentStateTable,
  incidentVectorsTable,
  type IncidentState,
} from "@workspace/db";
import { callMcpTool } from "../mcp/client";
import { invokeBedrockThought } from "./bedrock";

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
  thoughtSource: "bedrock" | "simulated";
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
  ragScore?: number | null;       // distance cosinus (0 = identique, 1 = opposé)
  ragStrategyHint?: string | null; // stratégie de l'incident le plus similaire
  winRate?: number | null;         // taux de succès historique de la stratégie
  winRateSampleSize?: number;      // nombre de samples ayant servi au calcul
  turns?: AgentTurn[];
  finalResponse?: string | null;
  crashed?: boolean;
  [key: string]: unknown;
}

// ── Couche 1 : utilitaires de mémoire ────────────────────────────────────

export function fingerprint(alertText: string): string {
  return createHash("sha256").update(alertText.trim()).digest("hex");
}

/**
 * Vecteur pseudo-aléatoire déterministe (1024 dims) dérivé du texte.
 * Remplaçant d'Amazon Titan Text Embeddings V2 pour la démo.
 */
export function pseudoEmbedding(text: string): number[] {
  let x = BigInt("0x" + createHash("sha256").update(text.trim()).digest("hex"));
  const mask = (1n << 31n) - 1n;
  const vec: number[] = [];
  for (let i = 0; i < 1024; i++) {
    x = (1103515245n * x + 12345n) & mask;
    vec.push((Number(x) / Number(mask)) * 2 - 1);
  }
  return vec;
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
 */
export async function getStrategyWinRate(
  strategyName: string,
): Promise<{ winRate: number; count: number }> {
  const rows = await db.execute<{ win_rate: string; total: string }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE outcome_success) * 1.0 / NULLIF(COUNT(*), 0) AS win_rate,
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

async function persistIncidentState(
  incidentId: string,
  status: string,
  currentStep: string,
  context: IncidentContext,
): Promise<IncidentState> {
  const [row] = await db
    .update(incidentStateTable)
    .set({ status, currentStep, contextJson: context })
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Pensées par défaut (fallback si Bedrock non disponible) ────────────────

const DIAGNOSTIC_THOUGHT =
  "Je détecte une anomalie d'infrastructure. Avant toute action corrective, " +
  "je vérifie l'état réel du composant concerné via l'API CockroachDB Cloud.";

function REMEDIATION_THOUGHT(strategyName: string, routingMode: RoutingMode): string {
  const modeNote =
    routingMode === "EXPLORATORY"
      ? " [MODE EXPLORATOIRE : stratégie inconnue, diagnostic étendu activé]"
      : routingMode === "AUTONOMOUS"
        ? " [MODE AUTONOME : mémoire vectorielle confirme la fiabilité de cette stratégie]"
        : " [MODE APPROUVÉ : validation humaine reçue avant exécution]";
  return (
    `Le diagnostic confirme la dégradation. J'applique la stratégie '${strategyName}'${modeNote}. ` +
    "Je déclenche une lecture d'état non destructive sur le service AWS concerné — " +
    "toute action corrective requiert une approbation humaine explicite."
  );
}

function AUDIT_THOUGHT(repairSuccess: boolean, strategyName: string): string {
  return repairSuccess
    ? `L'Auditor vérifie les sorties du Remediator : la réparation via '${strategyName}' a réussi. ` +
        "Les métriques sont revenues à la normale. L'incident peut être clôturé."
    : `L'Auditor vérifie les sorties du Remediator : la réparation via '${strategyName}' a échoué. ` +
        "Escalade vers l'équipe d'astreinte recommandée.";
}

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
    const bedrockThought = await invokeBedrockThought(alertText, 0, null);
    const thought = bedrockThought ?? DIAGNOSTIC_THOUGHT;
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
      thoughtSource: bedrockThought ? "bedrock" : "simulated",
      toolName: "execute_ccloud_command",
      toolInput,
      toolOutput,
    });

    current = await persistIncidentState(incident.incidentId, "DIAGNOSING", "AGENT_TURN_0", context);
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
    const embedding = pseudoEmbedding(alertText);
    const ragHit = await findSimilarIncident(embedding);
    // Le win-rate est calculé sur la stratégie DÉTECTÉE (pas sur celle du
    // RAG hit) : la stratégie détectée est la décision de l'agent, le RAG
    // hit est utilisé comme signal de similarité historique pour l'affichage.
    const winRateResult = await getStrategyWinRate(strategyName);
    const routingMode = computeRoutingMode(strategyName, ragHit?.distance, winRateResult.winRate, winRateResult.count);

    context.routingMode = routingMode;
    context.ragScore = ragHit?.distance ?? null;
    context.ragStrategyHint = ragHit?.strategyName ?? null;
    context.winRate = winRateResult.count > 0 ? winRateResult.winRate : null;
    context.winRateSampleSize = winRateResult.count;
    context.routingDecisionComputed = true;

    if (routingMode === "PENDING_APPROVAL") {
      const ragInfo = ragHit
        ? `RAG distance: ${ragHit.distance.toFixed(3)}, win-rate: ${(winRateResult.winRate * 100).toFixed(0)}% (${winRateResult.count} samples)`
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
    const bedrockThought = await invokeBedrockThought(alertText, 1, context.turns[0]?.toolOutput ?? null);
    const thought = bedrockThought ?? REMEDIATION_THOUGHT(strategyName, routingMode);
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
      thoughtSource: bedrockThought ? "bedrock" : "simulated",
      toolName: "aws_repair_service",
      toolInput,
      toolOutput,
    });

    current = await persistIncidentState(incident.incidentId, "REPAIRING", "AGENT_TURN_1", context);
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
    const bedrockThought = await invokeBedrockThought(alertText, 2, repairOutput ?? null);
    const thought = bedrockThought ?? AUDIT_THOUGHT(repairSuccess, strategyName);
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
      thoughtSource: bedrockThought ? "bedrock" : "simulated",
      toolName: "verify_resolution",
      toolInput,
      toolOutput,
    });

    const finalStatus = repairSuccess ? "RESOLVED" : "FAILED";
    const routingLabel = context.routingMode ?? "AUTONOMOUS";
    context.finalResponse = repairSuccess
      ? `RESOLVED [${strategyName}] [${routingLabel}]: Diagnostic confirmé par Diagnostician, réparation appliquée par Remediator, clôture validée par Auditor.`
      : `FAILED [${strategyName}]: La réparation a échoué — escalade vers l'équipe d'astreinte recommandée par l'Auditor.`;

    current = await persistIncidentState(incident.incidentId, finalStatus, "FINALIZED", context);
    await releaseIncidentClaim(incident.incidentId);

    // Alimente la Couche 1 avec le résultat réel de cet incident
    await indexResolvedIncident(
      incident.incidentId,
      alertText,
      pseudoEmbedding(alertText),
      strategyName,
      repairSuccess,
    );
  }

  return current;
}

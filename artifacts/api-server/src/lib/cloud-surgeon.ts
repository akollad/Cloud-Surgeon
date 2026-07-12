import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  executionLogsTable,
  incidentStateTable,
  incidentVectorsTable,
  type IncidentState,
} from "@workspace/db";
import { callMcpTool } from "../mcp/client";
import { invokeBedrockThought } from "./bedrock";

// ----------------------------------------------------------------------------
// Ce module joue le rôle du handler AWS Lambda (`backend/lambda_function.py`)
// à l'intérieur du serveur API de ce Repl : il reçoit une alerte, "réfléchit"
// (boucle d'agent simulée, en l'absence de credentials AWS Bedrock), écrit
// chaque étape immédiatement en base, et peut être interrompu puis repris
// exactement comme la vraie Lambda.
// ----------------------------------------------------------------------------

export function fingerprint(alertText: string): string {
  return createHash("sha256").update(alertText.trim()).digest("hex");
}

/**
 * Vecteur pseudo-aléatoire déterministe (1024 dims) dérivé d'un hash du
 * texte. Tient lieu de remplaçant à Amazon Titan Text Embeddings V2 pour la
 * démo, sans nécessiter de credentials AWS.
 */
export function pseudoEmbedding(text: string): number[] {
  let x = BigInt(
    "0x" + createHash("sha256").update(text.trim()).digest("hex"),
  );
  const mask = (1n << 31n) - 1n;
  const vec: number[] = [];
  for (let i = 0; i < 1024; i++) {
    x = (1103515245n * x + 12345n) & mask;
    vec.push((Number(x) / Number(mask)) * 2 - 1);
  }
  return vec;
}

// ----------------------------------------------------------------------------
// Détection de la stratégie à partir du texte d'alerte
// Chaque type d'incident connu mappe à une stratégie nommée, utilisée pour
// alimenter la mémoire vectorielle (win-rate par stratégie, Couche 1).
// ----------------------------------------------------------------------------
export function detectStrategy(alertText: string): string {
  const text = alertText.toLowerCase();
  if (text.includes("jvm") || text.includes("heap") || text.includes("oom")) return "jvm_heap_restart";
  if (text.includes("max_connections") || text.includes("connection pool") || text.includes("pg_stat")) return "db_connection_pool_reset";
  if (text.includes("latency") && (text.includes("cross-region") || text.includes("cross_region") || text.includes("bgp"))) return "network_route_failover";
  if (text.includes("accessdenied") || text.includes("credential") || text.includes("iam") || text.includes("expired")) return "iam_credential_rotation";
  if (text.includes("stripe") || text.includes("payment gateway") || text.includes("circuit")) return "external_dependency_circuit_break";
  if (text.includes("5xx") || text.includes("unhealthy") || (text.includes("ecs") && text.includes("service"))) return "ecs_service_restart";
  if (text.includes("cpu") || text.includes("rds")) return "rds_cpu_throttle";
  if (text.includes("throttl") || text.includes("concurrentexecution")) return "lambda_concurrency_scale";
  if (text.includes("disk") || text.includes("storage")) return "disk_cleanup";
  if (text.includes("cloudwatch") && text.includes("alarm")) return "cloudwatch_alarm_triage";
  return "default_repair";
}

interface AgentTurn {
  turn: number;
  thought: string;
  thoughtSource: "bedrock" | "simulated";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown>;
}

interface IncidentContext {
  alertText?: string;
  strategyName?: string;
  turns?: AgentTurn[];
  finalResponse?: string | null;
  crashed?: boolean;
  [key: string]: unknown;
}

const SCRIPT: Array<{
  thought: string;
  toolName: string;
  toolInput: (alertText: string) => Record<string, unknown>;
  statusAfter: string;
}> = [
  {
    thought:
      "Je détecte une anomalie d'infrastructure. Avant toute action corrective, " +
      "je vérifie l'état réel du composant concerné via la CLI ccloud.",
    toolName: "execute_ccloud_command",
    toolInput: (alertText) => ({
      commandJson: JSON.stringify({
        action: "cluster:status",
        target: alertText.slice(0, 40),
      }),
    }),
    statusAfter: "DIAGNOSING",
  },
  {
    thought:
      "Le diagnostic confirme la dégradation. Je déclenche une action de " +
      "réparation ciblée sur le service AWS concerné.",
    toolName: "aws_repair_service",
    toolInput: (alertText) => ({
      serviceName: detectServiceName(alertText),
      action: "describe_and_remediate",
    }),
    statusAfter: "REPAIRING",
  },
];

/** Extrait un nom de service lisible depuis le texte d'alerte. */
function detectServiceName(alertText: string): string {
  const serviceMatch = alertText.match(/'([^']+)'/);
  if (serviceMatch) return serviceMatch[1];
  const text = alertText.toLowerCase();
  if (text.includes("ecs")) return "ecs-service";
  if (text.includes("rds")) return "rds-instance";
  if (text.includes("lambda")) return "lambda-function";
  if (text.includes("ec2")) return "ec2-instance";
  return "auto-detected-service";
}

/**
 * Appelle l'outil via le serveur MCP (mcp/server.ts) plutôt que d'exécuter
 * une fonction locale en dur. `execute_ccloud_command` y fera un vrai appel
 * à l'API CockroachDB Cloud si `COCKROACH_CLOUD_API_KEY`/`_CLUSTER_ID` sont
 * configurées, sinon reste en simulation transparente.
 */
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
  return { success: false, error: `Outil inconnu: ${toolName}` };
}

export async function getOrCreateIncident(
  alertText: string,
): Promise<IncidentState> {
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

export async function getIncidentById(
  incidentId: string,
): Promise<IncidentState | undefined> {
  const [row] = await db
    .select()
    .from(incidentStateTable)
    .where(eq(incidentStateTable.incidentId, incidentId));
  return row;
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

export async function findSimilarIncident(
  embedding: number[],
): Promise<{ errorMessageText: string; strategyName: string; distance: number; outcomeSuccess: boolean } | undefined> {
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
    LIMIT 1;
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

/**
 * Indexe un incident résolu dans la mémoire vectorielle, avec la stratégie
 * employée et son résultat. C'est l'alimentation de la Couche 1 (bandit
 * contextuel porté par CockroachDB) : chaque incident résolu enrichit le
 * win-rate de la stratégie utilisée.
 */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rejoue la boucle d'agent à partir de l'étape déjà persistée dans
 * `incident.contextJson.turns` (résilience : on ne rejoue jamais un tour
 * déjà terminé). Si `simulateCrash` est vrai, s'arrête après le premier tour
 * sans finaliser l'incident — c'est le raccourci pédagogique utilisé par le
 * dashboard pour la démo (early return, pas un vrai crash de process).
 *
 * `CLOUD_SURGEON_CRASH_TEST_DELAY_MS` (variable d'env, absente en usage
 * normal) insère une pause entre deux tours *après* écriture en base, pour
 * laisser un script externe tuer réellement ce process (SIGKILL) en pleine
 * requête — voir `scripts/real-crash-test.sh`. C'est le seul moyen honnête
 * de prouver la résilience à un vrai crash, pas juste à un early return.
 */
export async function runAgentLoop(
  incident: IncidentState,
  alertText: string,
  simulateCrash: boolean,
): Promise<IncidentState> {
  if (incident.status === "RESOLVED" || incident.status === "FAILED") {
    return incident;
  }

  const context: IncidentContext = (incident.contextJson as IncidentContext) ?? {
    alertText,
    turns: [],
  };
  context.turns ??= [];

  // Détecter la stratégie si pas encore stockée dans le contexte
  if (!context.strategyName) {
    context.strategyName = detectStrategy(alertText);
  }
  const strategyName = context.strategyName;

  const startTurn = context.turns.length;
  let current = incident;

  for (let turnIndex = startTurn; turnIndex < SCRIPT.length; turnIndex++) {
    const step = SCRIPT[turnIndex];
    const toolInput = step.toolInput(alertText);
    const priorToolOutput = context.turns[turnIndex - 1]?.toolOutput ?? null;
    const bedrockThought = await invokeBedrockThought(alertText, turnIndex, priorToolOutput);
    const thought = bedrockThought ?? step.thought;
    const toolOutput = await callTool(step.toolName, toolInput);

    await logExecution(
      incident.incidentId,
      `${step.toolName}(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: turnIndex,
      thought,
      thoughtSource: bedrockThought ? "bedrock" : "simulated",
      toolName: step.toolName,
      toolInput,
      toolOutput,
    });

    // Écriture immédiate en base — c'est le point critique de résilience.
    current = await persistIncidentState(
      incident.incidentId,
      step.statusAfter,
      `AGENT_TURN_${turnIndex}`,
      context,
    );

    if (simulateCrash && turnIndex === startTurn) {
      context.crashed = true;
      current = await persistIncidentState(
        incident.incidentId,
        step.statusAfter,
        `AGENT_TURN_${turnIndex}`,
        context,
      );
      return current;
    }

    const crashTestDelayMs = Number(process.env.CLOUD_SURGEON_CRASH_TEST_DELAY_MS ?? 0);
    if (crashTestDelayMs > 0 && turnIndex < SCRIPT.length - 1) {
      await sleep(crashTestDelayMs);
    }
  }

  const finalResponse =
    `RESOLVED [${strategyName}]: Le service a été diagnostiqué et la stratégie de réparation appliquée avec succès. Métriques revenues à la normale.`;
  context.finalResponse = finalResponse;
  current = await persistIncidentState(
    incident.incidentId,
    "RESOLVED",
    "FINALIZED",
    context,
  );

  // Indexer l'incident résolu dans la mémoire vectorielle avec la stratégie
  // et le résultat — alimente le win-rate de la Couche 1.
  await indexResolvedIncident(
    incident.incidentId,
    alertText,
    pseudoEmbedding(alertText),
    strategyName,
    true, // outcomeSuccess = true car on a atteint RESOLVED
  );

  return current;
}

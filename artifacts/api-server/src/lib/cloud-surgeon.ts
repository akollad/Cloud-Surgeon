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
    toolInput: () => ({
      serviceName: "auto-detected-service",
      action: "restart",
    }),
    statusAfter: "REPAIRING",
  },
];

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

async function findSimilarIncident(
  embedding: number[],
): Promise<{ errorMessageText: string; distance: number } | undefined> {
  const literal = `[${embedding.join(",")}]`;
  const rows = await db.execute<{
    error_message_text: string;
    distance: number;
  }>(sql`
    SELECT error_message_text, embedding <=> ${literal}::vector AS distance
    FROM incident_vectors
    ORDER BY embedding <=> ${literal}::vector
    LIMIT 1;
  `);
  const row = rows.rows[0];
  return row
    ? { errorMessageText: row.error_message_text, distance: Number(row.distance) }
    : undefined;
}

async function indexResolvedIncident(
  errorMessageText: string,
  embedding: number[],
): Promise<void> {
  await db.insert(incidentVectorsTable).values({ errorMessageText, embedding });
}

/**
 * Rejoue la boucle d'agent à partir de l'étape déjà persistée dans
 * `incident.contextJson.turns` (résilience : on ne rejoue jamais un tour
 * déjà terminé). Si `simulateCrash` est vrai, s'arrête après le premier tour
 * sans finaliser l'incident, pour prouver qu'un appel HTTP suivant reprend
 * l'agent exactement là où il s'est arrêté au lieu de repartir de zéro.
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
  }

  const finalResponse =
    "RESOLVED: Le service a été redémarré avec succès et les métriques sont revenues à la normale.";
  context.finalResponse = finalResponse;
  current = await persistIncidentState(
    incident.incidentId,
    "RESOLVED",
    "FINALIZED",
    context,
  );

  await indexResolvedIncident(alertText, pseudoEmbedding(alertText));

  return current;
}

export { findSimilarIncident };

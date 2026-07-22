// ============================================================================
// Cloud-Surgeon — Layer 3: Multi-Agent Coordination
//
// CockroachDB serializable transactions are the arbiter for multi-agent
// locking. No separate lock service (Redis, ZooKeeper) is needed:
// the UPDATE … WHERE claimed_by_agent IS NULL RETURNING * in SERIALIZABLE
// isolation is atomic across concurrent agent invocations.
// ============================================================================

import { eq } from "drizzle-orm";
import { db, pool, incidentStateTable, agentHandoffsTable, type IncidentState } from "@workspace/db";
import type { AgentName } from "./agent-types";

/**
 * Claims an incident for a given agent via a CockroachDB serializable
 * transaction. Automatic retry on serialization error (code 40001).
 * Returns null if already claimed by another agent.
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
      if (result.rows.length === 0) return null;
      return mapRowToIncidentState(result.rows[0]);
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => {});
      const pgErr = err as { code?: string };
      if (pgErr.code === "40001" && attempt < MAX_RETRIES - 1) {
        // CockroachDB serialization conflict — exponential backoff
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

/**
 * Releases the claim on an incident (end of an agent phase).
 *
 * When `agentName` is provided, the UPDATE is guarded by a WHERE clause that
 * checks the current claimedByAgent value. This prevents a late-running or
 * recovering process for agent A from accidentally stripping a claim that
 * agent B has already taken (e.g. after a crash-and-recovery cycle).
 *
 * Omit agentName (startup force-release) only to clear a claim unconditionally.
 */
export async function releaseIncidentClaim(
  incidentId: string,
  agentName?: AgentName,
): Promise<void> {
  if (agentName) {
    // Scoped release: only clears the claim if this agent currently holds it.
    await pool.query(
      `UPDATE incident_state
       SET claimed_by_agent = NULL, updated_at = now()
       WHERE incident_id = $1 AND claimed_by_agent = $2`,
      [incidentId, agentName],
    );
  } else {
    // Unconditional release — used only by startup recovery to clear orphaned claims.
    await db
      .update(incidentStateTable)
      .set({ claimedByAgent: null })
      .where(eq(incidentStateTable.incidentId, incidentId));
  }
}

/** Logs an agent handoff in agent_handoffs. */
export async function logAgentHandoff(
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

// ── Cost estimation ───────────────────────────────────────────────────────

/**
 * Estimates CockroachDB Request Units consumed by a complete incident.
 *
 * Documented model (CockroachDB Serverless 2025 billing data):
 *   - ANN vector search (VECTOR, 1024 dims, <=> operator)               : ~5 RU
 *   - Serializable transactions (BEGIN SERIALIZABLE + UPDATE … RETURNING): ~3 RU * numAgents
 *   - Simple writes (INSERT/UPDATE on incident_state, logs, handoffs)    : ~2 RU * numWrites
 *   - Simple reads (SELECT)                                              : ~1 RU * numReads
 *   - Final vector write (INSERT into incident_vectors)                  : ~5 RU
 *   - Overhead (connections, metadata, auto-commit DDL)                  : ~3 RU
 */
export const BASE_RU_PER_INCIDENT = 42;

/**
 * Refines the estimate based on the actual number of turns
 * (each additional turn generates 1 write + 1 read = ~3 RU).
 */
export function estimateRuConsumed(turns: number): number {
  return BASE_RU_PER_INCIDENT + Math.max(0, turns - 3) * 3;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function mapRowToIncidentState(row: Record<string, unknown>): IncidentState {
  return {
    incidentId: row.incident_id as string,
    alertFingerprint: row.alert_fingerprint as string,
    status: row.status as string,
    currentStep: row.current_step as string | null,
    contextJson: row.context_json as Record<string, unknown>,
    claimedByAgent: row.claimed_by_agent as string | null,
    causedByIncidentId: row.caused_by_incident_id as string | null,
    triggeredAt: row.triggered_at as Date,
    resolvedAt: (row.resolved_at as Date | null) ?? null,
    ruConsumed: (row.ru_consumed as number) ?? 0,
    updatedAt: row.updated_at as Date,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

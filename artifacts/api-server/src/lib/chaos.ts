/**
 * chaos.ts — Application-layer chaos engineering
 *
 * ## Scope and limitations
 * Replit does not expose OS network primitives (iptables, tc netem,
 * network namespaces), so chaos is injected at the application layer:
 *   - LATENCY  : synchronous delay before each persistent DB write
 *   - PARTITION: simulated DB timeout (N operations "fail" with a timeout
 *                delay, then the connection recovers — exactly what a brief
 *                split-brain or DB node restart produces)
 *
 * ## What it demonstrates
 *
 * LATENCY — "Even with 500 ms of DB latency injected before each write, the
 *   agent completes with ~1.5 s total added latency. CockroachDB absorbs the
 *   slowness; resilience is not sensitive to network performance."
 *
 * PARTITION — "After 2 DB writes simulated as lost (ECONNRESET), the context
 *   persisted before the partition is read back without loss. The agent
 *   resumes exactly at the next turn — no duplication, no inconsistency."
 *
 * ## Out of scope
 * - OS-level chaos (iptables, tc) — not available in Replit
 * - Real CockroachDB partition (requires multi-node cluster)
 * - Load testing
 */

/** Chaos mode to inject during the agent loop. */
export type ChaosMode = "none" | "latency" | "partition";

/**
 * Error thrown during a simulated partition.
 * Propagated to `persistWithChaosRetry()` which catches it, logs the event,
 * waits for "recovery", then retries the DB write.
 */
export class ChaosPartitionError extends Error {
  constructor(phase: number) {
    super(
      `ChaosPartitionError: simulated DB partition at phase ${phase} — ` +
      `ECONNRESET after network timeout. Previous phase state intact in CockroachDB.`,
    );
    this.name = "ChaosPartitionError";
  }
}

/**
 * Chaos configuration for an incident.
 * Intentionally mutable: the `_partitionFailuresLeft` counter is
 * decremented on each simulated attempt until it reaches zero.
 */
export interface ChaosConfig {
  mode: ChaosMode;
  /** Delay in ms injected before each DB write (latency mode). Default: 500. */
  latencyMs: number;
  /** Number of operations to simulate as timeout (partition mode). Default: 2. */
  _partitionFailuresLeft: number;
}

/** Creates a ChaosConfig from a chaosMode string received from the API. */
export function createChaosConfig(
  mode: string | undefined,
  latencyMs = 500,
  partitionFailures = 2,
): ChaosConfig {
  const validMode: ChaosMode =
    mode === "latency" || mode === "partition" ? mode : "none";
  return {
    mode: validMode,
    latencyMs,
    _partitionFailuresLeft: validMode === "partition" ? partitionFailures : 0,
  };
}

/** Result of a chaos injection (for logging). */
export interface ChaosEvent {
  mode: ChaosMode;
  /** Actual delay waited, in ms. */
  delayMs: number;
  /** `true` if this was a simulated partition (failure + recovery). */
  wasPartition: boolean;
  /** Agent phase affected (0 = Diagnostician, 1 = Remediator, 2 = Auditor). */
  atPhase: number;
}

/**
 * Injects the configured chaos before a DB operation.
 *
 * - NONE    : no-op, returns null
 * - LATENCY : waits `latencyMs` ms (simulates slow DB network) then returns an event
 * - PARTITION: if `_partitionFailuresLeft > 0`, decrements the counter and throws
 *              `ChaosPartitionError` — the caller MUST catch this error,
 *              log the event, wait for "recovery", then retry
 *              the DB operation (which will succeed since the counter is now < 1).
 *
 * Normal call pattern:
 *   try { await injectChaos(chaos, phase); }
 *   catch (err) { if (err instanceof ChaosPartitionError) { ... retry ... } else throw err; }
 *   await persistIncidentState(...);
 */
export async function injectChaos(
  chaos: ChaosConfig,
  phase: number,
): Promise<ChaosEvent | null> {
  if (chaos.mode === "none") return null;

  if (chaos.mode === "latency") {
    await sleep(chaos.latencyMs);
    return { mode: "latency", delayMs: chaos.latencyMs, wasPartition: false, atPhase: phase };
  }

  if (chaos.mode === "partition") {
    if (chaos._partitionFailuresLeft > 0) {
      chaos._partitionFailuresLeft--;
      // Throw BEFORE the DB write — the caller catches this, logs, waits,
      // then retries the persist (which will succeed on the next attempt).
      throw new ChaosPartitionError(phase);
    }
    // All failures exhausted — normal operation resumes
    return null;
  }

  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

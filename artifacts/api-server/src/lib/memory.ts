// ============================================================================
// Cloud-Surgeon — Layer 1: Memory Utilities
//
// Fingerprinting, strategy detection, vector RAG, and incident storm detection.
// CockroachDB C-SPANN vector index powers both findSimilarIncident and
// detectIncidentStorm — no external vector store required.
// ============================================================================

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, incidentVectorsTable } from "@workspace/db";
import { generateEmbedding } from "./embeddings";
import {
  matchAlertPattern,
  ecsCluster,
  ecsDefaultRef,
  resolveEcsService,
  resolveLambdaFunction,
  lambdaDefaultFunction,
} from "./surgeon-config";

// ── Fingerprint ───────────────────────────────────────────────────────────

export function fingerprint(alertText: string): string {
  return createHash("sha256").update(alertText.trim()).digest("hex");
}

// ── Strategy detection ────────────────────────────────────────────────────

/**
 * Detects the repair strategy from the alert text.
 *
 * Priority:
 *  1. alert_patterns from cloud-surgeon.config.yaml (top-down, first match)
 *  2. Built-in CockroachDB patterns (specific, checked before generic AWS)
 *  3. Built-in AWS / generic patterns
 *
 * Clients override or extend step 1 without touching code.
 */
export function detectStrategy(alertText: string): string {
  // 1 — Config-defined patterns (client-customisable)
  const fromConfig = matchAlertPattern(alertText);
  if (fromConfig) return fromConfig;

  // 2 — Built-in CockroachDB patterns (fallback when config has no patterns)
  const t = alertText.toLowerCase();
  if (t.includes("hot range") || t.includes("hotspot") || (t.includes("cockroach") && t.includes("contention"))) return "crdb_hotspot_resolution";
  if ((t.includes("cockroach") || t.includes("crdb")) && (t.includes("full scan") || t.includes("table scan") || t.includes("missing index") || (t.includes("index") && t.includes("recommend")))) return "crdb_index_optimization";
  if ((t.includes("cockroach") || t.includes("crdb")) && (t.includes("slow query") || t.includes("long-running") || t.includes("long running") || t.includes("query timeout"))) return "crdb_slow_query_termination";
  if ((t.includes("cockroach") || t.includes("crdb")) && (t.includes("under-replicated") || t.includes("replication lag") || t.includes("range unavailable"))) return "crdb_replication_recovery";
  if (t.includes("changefeed") || (t.includes("cdc") && (t.includes("paused") || t.includes("stalled") || t.includes("failed") || t.includes("lag")))) return "crdb_changefeed_restart";

  // 3 — Built-in AWS / generic patterns
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

/**
 * Extracts a service reference from the alert text.
 *
 * Returns a value the aws_repair_service MCP tool can target:
 *   - ECS  → "cluster/service"  (e.g. "cloud-surgeon/checkout")
 *   - Lambda → bare function name (e.g. "order-processor")
 *   - RDS  → bare instance id   (e.g. "orders-db")
 *
 * Resolution order (highest specificity first):
 *  1. Single-quoted name in alert text
 *  2. Service alias match against config (e.g. "payment" → "checkout")
 *  3. Lambda function name / alias match
 *  4. "ECS service <name>" regex
 *  5. "RDS instance <name>" regex
 *  6. Compound hyphenated word heuristic
 *  7. Config default service fallback
 */
export function detectServiceName(alertText: string): string {
  const cluster   = ecsCluster();
  const defaultRef = ecsDefaultRef();
  const t = alertText.toLowerCase();

  // 1. Explicit single-quoted name — highest specificity.
  const quoted = alertText.match(/'([^']+)'/);
  if (quoted) {
    const name = quoted[1]!;
    if (t.includes("lambda") || t.includes("function")) return name;
    return name.includes("/") ? name : `${cluster}/${name}`;
  }

  // 2. Alias match against config services
  const resolvedEcs = resolveEcsService(t);
  if (resolvedEcs && !t.includes("lambda") && !t.includes("function")) {
    return `${cluster}/${resolvedEcs}`;
  }

  // 3. Lambda path
  if (t.includes("lambda") || t.includes("concurrentexecution")) {
    const fn = alertText.match(/(?:lambda\s+function|function)[:\s']+([a-zA-Z0-9_-]+)/i);
    if (fn) return fn[1]!;
    const word = alertText.match(/\b([a-zA-Z0-9]+-(?:processor|handler|worker|function))\b/i);
    if (word) {
      const resolved = resolveLambdaFunction(word[1]!);
      return resolved ?? word[1]!;
    }
    const resolvedLambda = resolveLambdaFunction(t);
    if (resolvedLambda) return resolvedLambda;
    return lambdaDefaultFunction();
  }

  // 4. "ECS service <name>" or "ECS task <name>"
  const ecsMatch = alertText.match(/ECS\s+(?:service|task)\s+(?:')?([a-zA-Z0-9_-]+)(?:')?/i);
  if (ecsMatch && ecsMatch[1]!.toLowerCase() !== "is" && ecsMatch[1]!.toLowerCase() !== "the") {
    const extracted = ecsMatch[1]!;
    const resolved = resolveEcsService(extracted);
    return `${cluster}/${resolved ?? extracted}`;
  }

  // 5. RDS instance identifier
  const rdsMatch = alertText.match(/RDS\s+(?:primary\s+)?(?:instance|db)\s+(?:')?([a-zA-Z0-9_-]+)(?:')?/i);
  if (rdsMatch) return rdsMatch[1]!;

  // 6. Compound hyphenated word heuristic
  const compoundMatch = alertText.match(/\b([a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9][a-zA-Z0-9_-]*)\b/);
  if (compoundMatch) {
    const candidate = compoundMatch[1]!;
    const skip = ["5xx-spike", "cpu-utilization", "max-connections", "idle-in-transaction"];
    if (!skip.some((s) => candidate.toLowerCase().includes(s))) {
      if (t.includes("lambda") || t.includes("function")) return candidate;
      const resolved = resolveEcsService(candidate);
      return `${cluster}/${resolved ?? candidate}`;
    }
  }

  // 7. Config default
  return defaultRef;
}

// ── Vector RAG ────────────────────────────────────────────────────────────

/**
 * Historical success rate for a strategy — the contextual bandit powered by
 * CockroachDB. No external ML service: a SQL aggregation is sufficient.
 *
 * The formula is weighted: each signal contributes according to its weight
 * (weight=1.0 for automatic outcomes, weight=0.5 for human signals).
 *
 *   win_rate = SUM(weight * outcome_success) / SUM(weight)
 */
export async function getStrategyWinRate(
  strategyName: string,
): Promise<{ winRate: number; count: number }> {
  const rows = await db.execute<{ win_rate: string; total: string }>(sql`
    SELECT
      SUM(CASE WHEN outcome_success THEN weight ELSE 0.0 END)
        / NULLIF(SUM(weight), 0.0) AS win_rate,
      COUNT(*) AS total
    FROM incident_vectors
    WHERE strategy_name = ${strategyName}
  `);
  const row = rows.rows[0];
  // Optimistic prior (0.85) on empty history: a fresh system should attempt
  // autonomous repair rather than stall in PENDING_APPROVAL.
  if (!row || row.total === "0") return { winRate: 0.85, count: 0 };
  return { winRate: Number(row.win_rate), count: Number(row.total) };
}

/** Win-rate for all known strategies — exposed via /api/metrics/win-rates. */
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

/** Nearest-neighbour lookup in incident_vectors via CockroachDB C-SPANN cosine ANN index. */
export async function findSimilarIncident(embedding: number[]): Promise<{
  errorMessageText: string;
  strategyName: string;
  distance: number;
  outcomeSuccess: boolean;
} | undefined> {
  // Wrapped in try/catch: a dimension mismatch between the embedding vector and the
  // DB column (e.g. after changing embedding models) throws a CockroachDB SQL error
  // rather than returning an empty result. Without this guard, the routing phase
  // crashes entirely instead of gracefully falling back to PENDING_APPROVAL.
  try {
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
  } catch {
    // Non-fatal: routing falls back to PENDING_APPROVAL when no RAG hit is available.
    return undefined;
  }
}

// ── Incident storm detection ──────────────────────────────────────────────
//
// An "incident storm" occurs when 3 or more semantically similar incidents
// arrive within a short time window — typically the signature of a cascading
// failure. Detection uses CockroachDB's C-SPANN vector index (cosine <=>):
// a single SQL query finds all embeddings within the similarity threshold
// AND within the time window. When a storm is detected, routing is forced to
// PENDING_APPROVAL — autonomous repair during a cascade would risk amplifying
// the outage.

export async function detectIncidentStorm(
  embedding: number[],
  options: { windowMinutes?: number; maxDistance?: number; minCount?: number } = {},
): Promise<{ isStorm: boolean; relatedCount: number; closestDistance: number | null }> {
  const { windowMinutes = 10, maxDistance = 0.35, minCount = 3 } = options;
  const literal = `[${embedding.join(",")}]`;

  try {
    const rows = await db.execute<{ cnt: string; min_dist: string | null }>(sql`
      SELECT COUNT(*)                                AS cnt,
             MIN(iv.embedding <=> ${literal}::vector) AS min_dist
      FROM   incident_vectors iv
      JOIN   incident_state ist ON ist.incident_id = iv.incident_id
      WHERE  ist.created_at > NOW() - (${windowMinutes.toString()} || ' minutes')::INTERVAL
        AND  iv.embedding <=> ${literal}::vector < ${maxDistance}
    `);
    const row = rows.rows[0];
    const cnt = Number(row?.cnt ?? 0);
    const minDist = row?.min_dist != null ? Number(row.min_dist) : null;
    return { isStorm: cnt >= minCount, relatedCount: cnt, closestDistance: minDist };
  } catch {
    // Non-fatal: storm detection must never block the agent loop
    return { isStorm: false, relatedCount: 0, closestDistance: null };
  }
}

// ── Embedding helper (re-exported for convenience) ────────────────────────

export { generateEmbedding };

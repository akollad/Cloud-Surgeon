import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  agentHandoffsTable,
  executionLogsTable,
  incidentStateTable,
  incidentVectorsTable,
  strategyCalibrationTable,
  type IncidentState,
} from "@workspace/db";
import { callMcpTool } from "../mcp/client";
import { invokeLLMThought, invokeLLMText } from "./llm";
import { generateEmbedding } from "./embeddings";
import { type ChaosConfig, ChaosPartitionError, injectChaos, sleep as chaosSleep } from "./chaos";

// ============================================================================
// Cloud-Surgeon — 3-Layer Architecture
//
// Layer 1: Causal and evaluated memory (vector RAG + SQL win-rate per strategy)
// Layer 2: Memory decides (AUTONOMOUS / PENDING_APPROVAL / EXPLORATORY routing)
// Layer 3: Multi-agent coordination via CockroachDB serializable transactions
// ============================================================================

// ── Types ─────────────────────────────────────────────────────────────────

export type RoutingMode = "AUTONOMOUS" | "PENDING_APPROVAL" | "EXPLORATORY" | "REJECTED";
export type AgentName = "diagnostician" | "remediator" | "auditor";

interface AgentTurn {
  turn: number;
  agent: AgentName;
  thought: string;
  thoughtSource: "anthropic" | "bedrock" | "simulated";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown>;
}

export interface RepairPlan {
  strategy: string;
  estimatedDuration: string;
  riskLevel: "low" | "medium" | "high";
  blastRadius: string;
  steps: string[];
  preconditions: string[];
  expectedOutcome: string;
  alternatives: string[];
  generatedBy: "llm" | "deterministic";
  generatedAt: string;
}

export interface RollbackInfo {
  steps: string[];
  estimatedTime: string;
  riskLevel: "low" | "medium" | "high";
  commandsExecuted: string[];
  warnings: string[];
  generatedAt: string;
}

export interface IncidentContext {
  alertText?: string;
  strategyName?: string;
  // Layer 2: routing decision and data that led to the decision
  routingMode?: RoutingMode;
  routingDecisionComputed?: boolean;
  ragScore?: number | null;         // cosine distance (0 = identical, 1 = opposite)
  ragStrategyHint?: string | null;  // strategy of the most similar historical incident
  winRate?: number | null;          // raw historical win-rate for the strategy
  winRateSampleSize?: number;       // number of samples used in the calculation
  // Layer 1 — automatic calibration
  correctionFactor?: number | null; // strategy correction factor (1.0 = neutral)
  effectiveWinRate?: number | null; // winRate * correctionFactor (used for routing)
  // Feature 2: pre-execution simulation plan
  repairPlan?: RepairPlan;
  // Feature 3: rollback info stored in context for quick access
  rollbackInfo?: RollbackInfo;
  turns?: AgentTurn[];
  finalResponse?: string | null;
  crashed?: boolean;
  [key: string]: unknown;
}

// ── Layer 1: memory utilities ─────────────────────────────────────────────

export function fingerprint(alertText: string): string {
  return createHash("sha256").update(alertText.trim()).digest("hex");
}


/** Detects the strategy to apply from the alert text. */
export function detectStrategy(alertText: string): string {
  const t = alertText.toLowerCase();
  // ── CockroachDB-specific patterns (checked first — more specific) ──────────
  if (t.includes("hot range") || t.includes("hotspot") || (t.includes("cockroach") && t.includes("contention"))) return "crdb_hotspot_resolution";
  if ((t.includes("cockroach") || t.includes("crdb")) && (t.includes("full scan") || t.includes("table scan") || t.includes("missing index") || (t.includes("index") && t.includes("recommend")))) return "crdb_index_optimization";
  if ((t.includes("cockroach") || t.includes("crdb")) && (t.includes("slow query") || t.includes("long-running") || t.includes("long running") || t.includes("query timeout"))) return "crdb_slow_query_termination";
  if ((t.includes("cockroach") || t.includes("crdb")) && (t.includes("under-replicated") || t.includes("replication lag") || t.includes("range unavailable"))) return "crdb_replication_recovery";
  if (t.includes("changefeed") || (t.includes("cdc") && (t.includes("paused") || t.includes("stalled") || t.includes("failed") || t.includes("lag")))) return "crdb_changefeed_restart";
  // ── AWS / generic patterns ──────────────────────────────────────────────────
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

/** Extracts a readable service name from the alert text.
 *
 * Returns a service reference the aws_repair_service MCP tool can target.
 * For ECS-routed alerts the format is "cluster/service" (e.g. "cloud-surgeon/api").
 * ECS_DEFAULT_CLUSTER / ECS_DEFAULT_SERVICE control the real service names so
 * this function never returns generic placeholders like "ecs-service" that would
 * cause "Cluster not found" / "Service not found" AWS errors.
 *
 * RDS and EC2 are NOT part of this infra (CockroachDB Serverless is the DB;
 * compute runs on Fargate). Alerts mentioning them are routed to the real ECS
 * service so at minimum the ECS task health is checked.
 */
export function detectServiceName(alertText: string): string {
  const ecsCluster = process.env.ECS_DEFAULT_CLUSTER ?? "cloud-surgeon";
  const ecsService = process.env.ECS_DEFAULT_SERVICE ?? "api";
  const ecsRef = `${ecsCluster}/${ecsService}`;
  const t = alertText.toLowerCase();

  // 1. Explicit single-quoted name wins — highest specificity.
  //    e.g. "ECS service 'checkout-api' unhealthy" → "checkout-api"
  const quoted = alertText.match(/'([^']+)'/);
  if (quoted) {
    const name = quoted[1]!;
    // If it looks like a function name (no slash), keep as-is for Lambda routing.
    if (t.includes("lambda") || t.includes("function")) return name;
    // Otherwise qualify with ECS cluster so extractEcsParams splits correctly.
    return name.includes("/") ? name : `${ecsCluster}/${name}`;
  }

  // 2. Lambda / serverless — return the function name so aws_repair_service
  //    routes to Lambda instead of ECS.
  if (t.includes("lambda") || t.includes("concurrentexecution")) {
    const fn = alertText.match(/(?:lambda\s+function|function)[:\s']+([a-zA-Z0-9_-]+)/i);
    if (fn) return fn[1]!;
    // Fallback: extract a hyphenated word that looks like a function name.
    const word = alertText.match(/\b([a-zA-Z0-9]+-(?:processor|handler|worker|function))\b/i);
    if (word) return word[1]!;
    // Last resort: use the configured default Lambda function so "Cascading Lambda
    // throttling" (and similar generic alerts) target a real function instead of
    // producing "Function not found: lambda/unknown".
    return process.env.LAMBDA_DEFAULT_FUNCTION ?? "lambda/unknown";
  }

  // 3. ECS service: "ECS service <name>" or "ECS task <name>"
  //    e.g. "ECS service checkout unhealthy" → "cloud-surgeon/checkout"
  const ecsMatch = alertText.match(/ECS\s+(?:service|task)\s+(?:')?([a-zA-Z0-9_-]+)(?:')?/i);
  if (ecsMatch && ecsMatch[1]!.toLowerCase() !== "is" && ecsMatch[1]!.toLowerCase() !== "the") {
    return `${ecsCluster}/${ecsMatch[1]!}`;
  }

  // 4. RDS instance identifier — return bare name so aws_repair_service
  //    can use RDS_INSTANCE_IDENTIFIER or the extracted name.
  const rdsMatch = alertText.match(/RDS\s+(?:primary\s+)?(?:instance|db)\s+(?:')?([a-zA-Z0-9_-]+)(?:')?/i);
  if (rdsMatch) return rdsMatch[1]!;

  // 5. Compound hyphenated service names (e.g. "recommendation-service", "order-processor")
  //    that appear before a verb — a reasonable heuristic for un-quoted names.
  const compoundMatch = alertText.match(/\b([a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9][a-zA-Z0-9_-]*)\b/);
  if (compoundMatch) {
    const candidate = compoundMatch[1]!;
    // Skip generic words that are not service names.
    const skip = ["5xx-spike", "cpu-utilization", "max-connections", "idle-in-transaction"];
    if (!skip.some((s) => candidate.toLowerCase().includes(s))) {
      if (t.includes("lambda") || t.includes("function")) return candidate;
      return `${ecsCluster}/${candidate}`;
    }
  }

  // 6. Fallback to the configured ECS service.
  return ecsRef;
}

/**
 * Historical success rate for a strategy — the contextual bandit powered by
 * CockroachDB. No external ML service: a SQL aggregation is sufficient.
 *
 * The formula is weighted: each signal contributes according to its weight
 * (weight=1.0 for automatic outcomes, weight=0.5 for human signals).
 * This prevents a few quick human rejections from overturning a history
 * of hundreds of resolved incidents.
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
  // autonomous repair rather than stall in PENDING_APPROVAL. After real outcomes
  // are recorded the calibration loop corrects the effective win-rate naturally.
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

// ── Layer 1: incident storm detection ────────────────────────────────────
//
// An "incident storm" occurs when 3 or more semantically similar incidents
// arrive within a short time window — typically the signature of a cascading
// failure or deployment rollout affecting multiple services simultaneously.
//
// Detection uses CockroachDB's C-SPANN vector index (cosine distance <=>):
// a single SQL query finds all historical vector embeddings whose distance
// from the new incident is below the similarity threshold AND whose source
// incident was created recently.
//
// When a storm is detected, the routing mode is forced to PENDING_APPROVAL
// regardless of historical win-rate — autonomous repair would risk amplifying
// a cascade (e.g. restarting all ECS services at once during a VPC failure).
// The human operator decides on a coordinated response.

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

// ── Feature 2: Pre-execution simulation plan ──────────────────────────────
//
// Before any AWS action, the agent generates a structured repair plan that
// lists the exact steps it will take, the estimated duration, blast radius,
// and risk level. This is stored in context_json.repairPlan so operators can
// review it on the dashboard and verify the agent's intent before execution.

const STRATEGY_PLANS: Record<string, Omit<RepairPlan, "strategy" | "generatedBy" | "generatedAt">> = {
  ecs_service_restart: {
    estimatedDuration: "45–90 seconds",
    riskLevel: "medium",
    blastRadius: "All tasks for the target ECS service",
    steps: [
      "Describe current ECS service task count and health",
      "Force a new deployment (rolling restart of tasks)",
      "Wait for new tasks to reach RUNNING state",
      "Drain and deregister old tasks from ALB target group",
      "Verify ALB health checks pass on new tasks",
    ],
    preconditions: [
      "ECS service must exist and be in ACTIVE state",
      "Minimum 1 healthy task must survive the rolling restart",
      "ALB target group health check endpoint must respond within 30 s",
    ],
    expectedOutcome: "Service returns to healthy state with all tasks running",
    alternatives: ["scale_out_ecs (add capacity without restart)", "rds_cpu_throttle (if DB is root cause)"],
  },
  rds_cpu_throttle: {
    estimatedDuration: "15–30 seconds",
    riskLevel: "low",
    blastRadius: "Single RDS instance — read-only performance during modification",
    steps: [
      "Check RDS instance CPU and connection metrics",
      "Identify slow or blocking queries via pg_stat_activity",
      "Terminate longest-running queries consuming > 80% CPU",
      "Apply parameter group change to reduce max_connections if needed",
      "Validate CPU returns below 70% threshold",
    ],
    preconditions: ["RDS instance must be in 'available' state", "DB user must have SUPERUSER privileges"],
    expectedOutcome: "RDS CPU utilization returns below warning threshold within 30 seconds",
    alternatives: ["lambda_concurrency_scale (offload compute)", "ecs_service_restart (reduce DB load)"],
  },
  lambda_concurrency_scale: {
    estimatedDuration: "10–20 seconds",
    riskLevel: "low",
    blastRadius: "Target Lambda function concurrency limits only",
    steps: [
      "Get current reserved concurrency setting",
      "Increase reserved concurrency by 2x (up to account limit)",
      "Monitor throttle errors (ConcurrentExecutionLimitExceeded) for 60 s",
      "If errors persist, check Lambda duration for downstream bottleneck",
    ],
    preconditions: ["Lambda function must exist", "Account concurrency limit must have headroom"],
    expectedOutcome: "Lambda throttle rate drops to 0 within 20 seconds of scaling",
    alternatives: ["ecs_service_restart (queue backlog drain)", "external_dependency_circuit_break"],
  },
  jvm_heap_restart: {
    estimatedDuration: "60–120 seconds",
    riskLevel: "medium",
    blastRadius: "All JVM processes for the service (brief unavailability)",
    steps: [
      "Trigger heap dump for post-mortem analysis",
      "Send SIGTERM to JVM processes (graceful shutdown)",
      "Supervisor/ECS restarts the process with clean heap",
      "Verify JVM heap usage drops below 70%",
      "Confirm service health check passes",
    ],
    preconditions: ["Service must handle SIGTERM gracefully", "Heap dump destination must have disk space"],
    expectedOutcome: "JVM heap resets to initial state; GC pressure eliminated",
    alternatives: ["ecs_service_restart (container-level restart)", "rds_cpu_throttle (if OOM from DB result sets)"],
  },
  db_connection_pool_reset: {
    estimatedDuration: "5–15 seconds",
    riskLevel: "low",
    blastRadius: "Existing DB connections for the target pool",
    steps: [
      "Check pg_stat_activity for idle connections exceeding pool limit",
      "Terminate idle connections older than 5 minutes",
      "Reset connection pool configuration (max_connections, idle_timeout)",
      "Verify new connections can be established",
    ],
    preconditions: ["DB must be reachable", "Application must reconnect automatically on connection drop"],
    expectedOutcome: "Connection pool drains to healthy level; pg_stat_activity idle count normalizes",
    alternatives: ["rds_cpu_throttle (if connections high due to slow queries)"],
  },
  network_route_failover: {
    estimatedDuration: "30–60 seconds",
    riskLevel: "high",
    blastRadius: "All cross-region traffic — full network path change",
    steps: [
      "Verify BGP peering status on both regions",
      "Update Route 53 health check to mark primary region unhealthy",
      "Failover DNS to secondary region (propagation: 30–60 s)",
      "Verify secondary region is absorbing traffic",
      "Monitor latency on failover path",
    ],
    preconditions: ["Secondary region must be warm and healthy", "Route 53 failover routing policy must be pre-configured"],
    expectedOutcome: "Traffic rerouted to secondary region; cross-region latency returns to baseline",
    alternatives: ["ecs_service_restart (if application-layer, not network)"],
  },
  iam_credential_rotation: {
    estimatedDuration: "20–45 seconds",
    riskLevel: "medium",
    blastRadius: "All services using the affected IAM user/role",
    steps: [
      "Identify expired or revoked IAM credentials",
      "Generate new access key pair for IAM user",
      "Update Secret Manager / Parameter Store with new credentials",
      "Trigger rolling restart of affected ECS tasks to pick up new creds",
      "Delete old access key pair",
    ],
    preconditions: ["IAM user must not have reached 2-key limit", "Secrets Manager must be writable"],
    expectedOutcome: "AccessDenied errors stop within 60 s as services rotate to new credentials",
    alternatives: ["ecs_service_restart (if only task needs refresh)"],
  },
  external_dependency_circuit_break: {
    estimatedDuration: "5–10 seconds",
    riskLevel: "low",
    blastRadius: "Requests to the failing external dependency only",
    steps: [
      "Confirm external dependency is returning errors",
      "Open circuit breaker (reject calls, return cached/fallback response)",
      "Enable retry queue with exponential backoff",
      "Monitor circuit breaker state every 30 s for auto-recovery",
    ],
    preconditions: ["Circuit breaker library must be integrated in the service", "Fallback response must be defined"],
    expectedOutcome: "Cascading failure stops; service returns graceful degraded mode",
    alternatives: ["lambda_concurrency_scale (if retry storm overloads compute)"],
  },
  disk_cleanup: {
    estimatedDuration: "30–120 seconds",
    riskLevel: "low",
    blastRadius: "Disk I/O on the target instance during cleanup",
    steps: [
      "Check disk usage per directory (df, du)",
      "Identify and rotate old log files (> 7 days)",
      "Clear temporary files and build artifacts",
      "Trigger EBS snapshot if disk > 90% before cleanup",
      "Verify disk usage drops below 80%",
    ],
    preconditions: ["Instance must be reachable via SSM Session Manager"],
    expectedOutcome: "Disk usage returns below 80%; no data loss from production files",
    alternatives: ["ecs_service_restart (if disk used by container overlay FS)"],
  },
  cloudwatch_alarm_triage: {
    estimatedDuration: "15–30 seconds",
    riskLevel: "low",
    blastRadius: "CloudWatch alarm state only — no service impact",
    steps: [
      "Retrieve alarm history (last 24h)",
      "Check if alarm is due to metric spike or sustained degradation",
      "Determine if alarm threshold needs tuning (false positive)",
      "If genuine: escalate to appropriate repair strategy",
      "Acknowledge alarm in CloudWatch if handled",
    ],
    preconditions: ["CloudWatch GetMetricData access"],
    expectedOutcome: "Alarm root cause identified; either resolved or escalated to correct strategy",
    alternatives: ["ecs_service_restart", "rds_cpu_throttle", "lambda_concurrency_scale"],
  },
  default_repair: {
    estimatedDuration: "60–180 seconds",
    riskLevel: "medium",
    blastRadius: "Unknown — generic repair mode, scope TBD",
    steps: [
      "Describe all resources mentioned in alert",
      "Check health status of primary service",
      "Attempt soft restart (graceful) before hard restart",
      "Monitor for 60 s to confirm improvement",
    ],
    preconditions: ["Target service must be identifiable from alert text"],
    expectedOutcome: "Service returns to healthy state; monitoring confirms incident closure",
    alternatives: ["Trigger specific strategy once root cause is confirmed"],
  },

  // ── CockroachDB Agent Skills strategies ───────────────────────────────────
  // These strategies invoke the CockroachDB Agent Skills (open-source repo)
  // via the official CockroachDB Cloud MCP endpoint instead of AWS APIs.
  // Each skill is machine-executable and returns structured JSON for the agent.

  crdb_hotspot_resolution: {
    estimatedDuration: "30–90 seconds",
    riskLevel: "low",
    blastRadius: "Read-only diagnostics — no cluster state changes",
    steps: [
      "Query crdb_internal.cluster_contention_events via Agent Skill: crdb/performance/diagnose-hotspots",
      "Identify top-N contention sources (table, index, cumulative wait time)",
      "Query crdb_internal.ranges_no_leases to find oversized ranges",
      "Invoke Agent Skill: crdb/schema/index-advisor to surface missing indexes",
      "Generate DDL recommendations (hash-sharded index, range split point)",
      "Schedule maintenance window for DDL application",
    ],
    preconditions: [
      "COCKROACH_CLOUD_API_KEY configured and cluster accessible via MCP",
      "Agent has SELECT on crdb_internal schema",
    ],
    expectedOutcome: "Hot contention ranges identified; index DDL recommendations ready to apply",
    alternatives: ["crdb_index_optimization (schema-only fix)", "crdb_slow_query_termination (if queries are the hot source)"],
  },

  crdb_index_optimization: {
    estimatedDuration: "15–30 seconds",
    riskLevel: "low",
    blastRadius: "Read-only diagnostics — DDL applied separately in maintenance window",
    steps: [
      "Invoke Agent Skill: crdb/schema/index-advisor",
      "Query crdb_internal.index_recommendations for missing and redundant indexes",
      "Collect CREATE INDEX and DROP INDEX DDL statements from recommendations",
      "Rank recommendations by impact (full table scans first)",
      "Generate migration script for human review",
    ],
    preconditions: [
      "COCKROACH_CLOUD_API_KEY configured",
      "At least one query has been executed (optimizer must have observed full scans)",
    ],
    expectedOutcome: "Index recommendations list generated; apply DDL to eliminate full-table scans",
    alternatives: ["crdb_hotspot_resolution (if index changes cause hot spots)", "crdb_slow_query_termination (immediate relief)"],
  },

  crdb_slow_query_termination: {
    estimatedDuration: "10–20 seconds",
    riskLevel: "low",
    blastRadius: "Terminated queries experience rollback — no data loss",
    steps: [
      "Invoke Agent Skill: crdb/operations/cancel-query (dry-run=true)",
      "List all queries running longer than 30 seconds via crdb_internal.cluster_queries",
      "Identify top offenders by duration and resource consumption",
      "If approved, invoke crdb/operations/cancel-query (dry-run=false) to cancel top-3",
      "Verify connection pool normalizes within 30 s",
    ],
    preconditions: [
      "COCKROACH_CLOUD_API_KEY configured",
      "Queries must be in flight (not already committed or rolled back)",
    ],
    expectedOutcome: "Long-running query pool drains; connection count normalizes within 30 s",
    alternatives: ["crdb_index_optimization (prevent future slow queries)", "crdb_hotspot_resolution (if slowness is contention-driven)"],
  },

  crdb_replication_recovery: {
    estimatedDuration: "60–300 seconds",
    riskLevel: "medium",
    blastRadius: "Cluster-level — under-replicated ranges affect read/write availability",
    steps: [
      "Invoke Agent Skill: crdb/observability/job-status to check background jobs",
      "Query crdb_internal.ranges_no_leases for under-replicated ranges",
      "Check cluster health via official CockroachDB Cloud MCP (get_cluster)",
      "Identify whether a node is dead or decommissioning",
      "If node is dead: trigger decommission via ccloud cluster node decommission",
      "Monitor replica count recovery (expect full replication within 5 min of node recovery)",
    ],
    preconditions: [
      "COCKROACH_CLOUD_API_KEY configured",
      "Cluster must have at least one live node per region",
    ],
    expectedOutcome: "Under-replicated ranges recover to RF=3 within 5 minutes of node restore",
    alternatives: ["crdb_hotspot_resolution (if range unavailability is load-driven, not node failure)"],
  },

  crdb_changefeed_restart: {
    estimatedDuration: "20–45 seconds",
    riskLevel: "low",
    blastRadius: "Downstream consumers may see duplicate events during CDC catch-up",
    steps: [
      "Invoke Agent Skill: crdb/observability/job-status (filter: changefeed, status: paused/failed)",
      "Identify paused or failed changefeeds with their job IDs",
      "Check last_error for root cause (network partition, schema change, backfill stall)",
      "Execute RESUME JOB <id> for each paused changefeed via crdb_query",
      "Monitor changefeed lag metric to confirm catch-up within 60 s",
    ],
    preconditions: [
      "COCKROACH_CLOUD_API_KEY configured",
      "Changefeed sink (Kafka / webhook / S3) must be reachable from cluster",
    ],
    expectedOutcome: "Changefeed resumes and catches up; downstream consumers receive all missed events",
    alternatives: ["crdb_replication_recovery (if changefeed paused due to under-replicated ranges)"],
  },
};

export async function generateRepairPlan(
  alertText: string,
  strategyName: string,
  serviceName: string,
): Promise<RepairPlan> {
  const base = STRATEGY_PLANS[strategyName] ?? STRATEGY_PLANS.default_repair!;
  const plan: RepairPlan = {
    strategy: strategyName,
    ...base,
    generatedBy: "deterministic",
    generatedAt: new Date().toISOString(),
  };

  // Enrich expected outcome with LLM — works with any configured provider (Nova Lite or Anthropic)
  try {
    const outcomePrompt =
      `You are a DevOps expert. Service '${serviceName}' triggered: "${alertText.slice(0, 200)}". ` +
      `Repair strategy: ${strategyName}. ` +
      `Write ONE sentence naming the specific measurable state expected within 90 seconds of a successful repair — ` +
      `a metric dropping below a threshold, a count reaching zero, or a service reaching a target health state. ` +
      `Respond with ONLY that sentence, no preamble.`;
    const result = await invokeLLMText(outcomePrompt, strategyName);
    if (result) { plan.expectedOutcome = result; plan.generatedBy = "llm"; }
  } catch { /* non-fatal */ }

  return plan;
}

// ── Feature 3: Rollback policy ─────────────────────────────────────────────
//
// After every AWS repair, Cloud-Surgeon captures the executed commands and
// generates step-by-step rollback instructions. Stored in rollback_plans
// (CockroachDB) + context_json.rollbackInfo (for instant dashboard display).

const ROLLBACK_STEPS: Record<string, string[]> = {
  // ── CockroachDB Agent Skills rollback steps ────────────────────────────────
  crdb_hotspot_resolution: [
    "No structural changes were made — hotspot diagnosis is read-only",
    "If DDL was applied (new index): DROP INDEX CONCURRENTLY <index_name>",
    "Monitor crdb_internal.cluster_contention_events to confirm contention did not worsen",
  ],
  crdb_index_optimization: [
    "If CREATE INDEX was applied: DROP INDEX CONCURRENTLY <table>@<index_name>",
    "If DROP INDEX was applied: recreate with original CREATE INDEX statement",
    "Run EXPLAIN SELECT ... to confirm query plan is still efficient after rollback",
  ],
  crdb_slow_query_termination: [
    "Cancelled queries roll back automatically — no action needed",
    "Re-submit cancelled queries if they were legitimate (check application logs)",
    "If cancellations caused application errors, restart application pods to reconnect pool",
  ],
  crdb_replication_recovery: [
    "If node was decommissioned incorrectly: ccloud cluster node recommission <node-id>",
    "Check under-replicated ranges: SELECT * FROM crdb_internal.ranges_no_leases WHERE array_length(replicas,1) < 3",
    "Contact CockroachDB support if ranges do not recover within 10 minutes",
  ],
  crdb_changefeed_restart: [
    "If changefeed resumed incorrectly: PAUSE JOB <job_id>",
    "Downstream consumers must handle duplicate events (at-least-once delivery)",
    "Verify sink (Kafka/webhook) deduplication logic handles replay correctly",
  ],
  ecs_service_restart: [
    "Identify previous task definition: aws ecs describe-services --cluster <cluster> --services <service>",
    "Roll back: aws ecs update-service --cluster <cluster> --service <service> --task-definition <family:N-1> --force-new-deployment",
    "Wait for rollback deployment to stabilize (watch aws ecs describe-services)",
    "Verify ALB health checks pass on rolled-back tasks",
  ],
  rds_cpu_throttle: [
    "Restore original parameter group: aws rds modify-db-parameter-group --db-parameter-group-name <group> --parameters 'ParameterName=max_connections,ParameterValue=<original>,ApplyMethod=pending-reboot'",
    "If reboot required: aws rds reboot-db-instance --db-instance-identifier <id>",
    "Restart any legitimate long-running queries that were terminated",
  ],
  lambda_concurrency_scale: [
    "Restore original concurrency: aws lambda put-function-concurrency --function-name <fn> --reserved-concurrent-executions <original>",
    "Monitor throttle rate for 60 s to confirm rollback did not reintroduce issues",
  ],
  jvm_heap_restart: [
    "If post-restart behaviour is wrong, roll back ECS task definition to previous image",
    "aws ecs update-service --cluster <cluster> --service <service> --task-definition <family:N-1> --force-new-deployment",
    "Inspect heap dump at /tmp/heapdump-*.hprof for root cause analysis",
  ],
  db_connection_pool_reset: [
    "Restore original connection pool configuration in application config",
    "aws ecs update-service --force-new-deployment to pick up config change",
    "Reconnect application pools",
  ],
  network_route_failover: [
    "Mark primary region healthy in Route 53 health check",
    "Restore primary Route 53 weighted/failover record",
    "aws route53 change-resource-record-sets — restore primary record",
    "Wait for DNS TTL to propagate (60 s)",
  ],
  iam_credential_rotation: [
    "If new key does not work, activate old key temporarily: aws iam update-access-key --access-key-id <old-key-id> --status Active",
    "Update Secrets Manager back to old credentials",
    "Trigger ECS rolling restart to pick up old credentials",
  ],
  external_dependency_circuit_break: [
    "Close circuit breaker to allow traffic through again",
    "Monitor error rate — if > 5% within 30 s, re-open circuit",
    "Investigate external dependency status page before reopening",
  ],
  disk_cleanup: [
    "No automated rollback for deleted files — restore from EBS snapshot if critical data lost",
    "aws ec2 describe-snapshots --filters Name=volume-id,Values=<volume-id>",
    "aws ec2 create-volume --snapshot-id <snapshot-id> --availability-zone <az>",
  ],
  cloudwatch_alarm_triage: [
    "No infrastructure changes made — alarm triage is read-only",
    "If alarm threshold was modified, restore original value in CloudWatch console",
  ],
  default_repair: [
    "Restore previous service version via ECS task definition rollback",
    "Check CloudWatch logs for errors introduced by the repair",
    "Open incident for human review if uncertain",
  ],
};

const ROLLBACK_RISK: Record<string, "low" | "medium" | "high"> = {
  // CockroachDB Agent Skills
  crdb_hotspot_resolution: "low", crdb_index_optimization: "low",
  crdb_slow_query_termination: "low", crdb_replication_recovery: "medium",
  crdb_changefeed_restart: "low",
  // AWS strategies
  ecs_service_restart: "medium", rds_cpu_throttle: "low", lambda_concurrency_scale: "low",
  jvm_heap_restart: "medium", db_connection_pool_reset: "low", network_route_failover: "high",
  iam_credential_rotation: "high", external_dependency_circuit_break: "low",
  disk_cleanup: "medium", cloudwatch_alarm_triage: "low", default_repair: "medium",
};

const ROLLBACK_TIMES: Record<string, string> = {
  // CockroachDB Agent Skills
  crdb_hotspot_resolution: "N/A (read-only)", crdb_index_optimization: "< 30 seconds (DROP INDEX CONCURRENTLY)",
  crdb_slow_query_termination: "N/A (queries auto-rollback)", crdb_replication_recovery: "5–10 minutes",
  crdb_changefeed_restart: "< 30 seconds (PAUSE JOB)",
  // AWS strategies
  ecs_service_restart: "2–5 minutes", rds_cpu_throttle: "1–2 minutes",
  lambda_concurrency_scale: "< 30 seconds", jvm_heap_restart: "2–4 minutes",
  db_connection_pool_reset: "< 1 minute", network_route_failover: "1–3 minutes (DNS propagation)",
  iam_credential_rotation: "2–3 minutes", external_dependency_circuit_break: "< 15 seconds",
  disk_cleanup: "5–30 minutes (from snapshot)", cloudwatch_alarm_triage: "N/A (read-only)",
  default_repair: "5–10 minutes",
};

async function generateAndStoreRollbackPlan(
  incidentId: string,
  strategyName: string,
  toolOutput: Record<string, unknown>,
  preRepairState: Record<string, unknown>,
): Promise<RollbackInfo> {
  const steps = ROLLBACK_STEPS[strategyName] ?? ROLLBACK_STEPS.default_repair!;
  const estimatedTime = ROLLBACK_TIMES[strategyName] ?? "5–10 minutes";
  const riskLevel = ROLLBACK_RISK[strategyName] ?? "medium";

  const commandsExecuted: string[] = [];
  if (toolOutput.action) commandsExecuted.push(`Action executed: ${toolOutput.action}`);
  if (toolOutput.serviceName) commandsExecuted.push(`Target service: ${toolOutput.serviceName}`);
  if (toolOutput.steps && Array.isArray(toolOutput.steps)) {
    for (const step of (toolOutput.steps as unknown[]).slice(0, 5)) {
      commandsExecuted.push(`• ${String(step).slice(0, 150)}`);
    }
  } else if (toolOutput.detail) {
    commandsExecuted.push(`Detail: ${String(toolOutput.detail).slice(0, 200)}`);
  }
  if (commandsExecuted.length === 0) {
    commandsExecuted.push(`aws_repair_service(strategy=${strategyName}, service=${preRepairState.serviceName ?? "auto-detected"})`);
  }

  const warnings: string[] = [];
  if (riskLevel === "high") warnings.push("⚠ High-risk rollback — coordinate with on-call team before executing.");
  if (strategyName === "disk_cleanup") warnings.push("⚠ Deleted files cannot be recovered without a snapshot.");
  if (strategyName === "network_route_failover") warnings.push("⚠ DNS propagation takes 60 s — traffic will continue on failover path during rollback.");

  const rollbackInfo: RollbackInfo = {
    steps, estimatedTime, riskLevel, commandsExecuted, warnings,
    generatedAt: new Date().toISOString(),
  };

  try {
    await pool.query(
      `INSERT INTO rollback_plans
         (incident_id, strategy_name, pre_repair_state, executed_commands, rollback_steps, estimated_rollback_time, risk_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (incident_id) DO UPDATE
         SET executed_commands = EXCLUDED.executed_commands,
             rollback_steps    = EXCLUDED.rollback_steps`,
      [
        incidentId, strategyName, JSON.stringify(preRepairState),
        commandsExecuted.join("\n"), steps.join("\n"), estimatedTime, riskLevel,
      ],
    );
  } catch (err) {
    const { logger } = await import("./logger");
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[Rollback] DB persist failed (non-fatal)");
  }

  return rollbackInfo;
}

/** Applied at server startup — idempotent DDL for rollback_plans table. */
export async function createRollbackPlansTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rollback_plans (
      rollback_id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      incident_id              UUID         NOT NULL UNIQUE REFERENCES incident_state(incident_id),
      strategy_name            VARCHAR(100) NOT NULL,
      pre_repair_state         JSONB        NOT NULL DEFAULT '{}',
      executed_commands        TEXT         NOT NULL DEFAULT '',
      rollback_steps           TEXT         NOT NULL DEFAULT '',
      estimated_rollback_time  VARCHAR(50),
      risk_level               VARCHAR(20)  NOT NULL DEFAULT 'low',
      created_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `);
}

// ── Layer 1: AI-generated repair playbooks ────────────────────────────────
//
// After each resolved incident the agent synthesises a structured Markdown
// playbook from its own turn history and stores it in CockroachDB.
// Unlike AWS SSM or PagerDuty runbooks (which are human-written),
// these playbooks are generated by the same model that executed the repair,
// so they capture the actual reasoning chain — not a post-hoc template.
//
// Stored in the `playbooks` table; retrievable via GET /api/metrics/playbooks.

export async function generateAndStorePlaybook(
  incidentId: string,
  alertText: string,
  strategyName: string,
  turns: Array<{
    turn: number;
    agent: string;
    thought: string;
    toolName: string;
    toolOutput: Record<string, unknown>;
  }>,
): Promise<void> {
  try {
    const actionLines = turns
      .map(
        (t) =>
          `### Turn ${t.turn} — ${t.agent}\n` +
          `**Thought:** ${t.thought.slice(0, 300)}${t.thought.length > 300 ? "…" : ""}\n` +
          `**Tool:** \`${t.toolName}\`\n` +
          `**Result:** \`${JSON.stringify(t.toolOutput).slice(0, 400)}\``,
      )
      .join("\n\n");

    const content = [
      `# Repair Playbook — ${strategyName}`,
      "",
      `## Triggering Alert`,
      alertText,
      "",
      `## Strategy Applied`,
      `\`${strategyName}\``,
      "",
      `## Agent Reasoning & Actions`,
      actionLines,
      "",
      `## Resolution`,
      `Incident resolved via **${strategyName}**. This playbook is stored in CockroachDB`,
      `and retrieved by vector similarity for future similar incidents, closing the`,
      `RAG loop: detect → diagnose → repair → document → recall.`,
    ].join("\n");

    const title = `${strategyName} — ${alertText.slice(0, 60)}${alertText.length > 60 ? "…" : ""}`;

    await pool.query(
      `INSERT INTO playbooks (incident_id, strategy_name, title, content_md)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (incident_id) DO UPDATE
         SET title      = EXCLUDED.title,
             content_md = EXCLUDED.content_md`,
      [incidentId, strategyName, title, content],
    );
  } catch (err) {
    // Playbook generation must never fail an incident
    const logger = (await import("./logger")).logger;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[Playbook] Generation failed (non-fatal)",
    );
  }
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
  // Immediately recalibrate this strategy so future routing decisions benefit
  // from the latest outcome.
  await recalibrateStrategy(strategyName);
}

// ── Layer 1: automatic bandit calibration ────────────────────────────────

/**
 * Deviation threshold (absolute value) between predicted and observed win-rate
 * above which the correction factor is activated.
 * Configurable via CALIBRATION_THRESHOLD env var (default: 0.15 = 15%).
 */
const CALIBRATION_THRESHOLD = Number(process.env.CALIBRATION_THRESHOLD ?? 0.15);

/**
 * Records the predicted win-rate at the time of a routing decision.
 *
 * Maintains a weighted rolling average by the number of decisions
 * (`prediction_count`) so that recent decisions do not excessively bias
 * the history. Uses a CockroachDB UPSERT:
 *
 *   new_avg = (old_avg * old_count + new_prediction) / (old_count + 1)
 *
 * Called once per incident, just before the routing decision.
 */
async function recordRoutingPrediction(
  strategyName: string,
  predictedWinRate: number,
): Promise<void> {
  // CockroachDB rejects FLOAT * INT — cast prediction_count to FLOAT explicitly.
  await db.execute(sql`
    INSERT INTO strategy_calibration (strategy_name, avg_predicted_win_rate, prediction_count, last_recalculated_at)
    VALUES (${strategyName}, ${predictedWinRate}, 1, now())
    ON CONFLICT (strategy_name) DO UPDATE
    SET avg_predicted_win_rate =
          (strategy_calibration.avg_predicted_win_rate * strategy_calibration.prediction_count::float
            + EXCLUDED.avg_predicted_win_rate)
          / (strategy_calibration.prediction_count::float + 1.0),
        prediction_count      = strategy_calibration.prediction_count + 1,
        last_recalculated_at  = now()
  `);
}

/**
 * Recomputes the real (observed) win-rate from `incident_vectors` for a
 * strategy and updates the correction factor in `strategy_calibration`.
 *
 * Correction factor formula:
 *   - If |observed − predicted| ≤ CALIBRATION_THRESHOLD → correction_factor = 1.0 (neutral)
 *   - Otherwise → correction_factor = clamp(observed / predicted, 0.1, 1.5)
 *
 * A factor < 1 downgrades future decisions (too many unexpected failures).
 * A factor > 1 upgrades future decisions (better performance than expected).
 *
 * Fully powered by CockroachDB — no external ML service.
 */
export async function recalibrateStrategy(strategyName: string): Promise<void> {
  // Observed win-rate = SQL aggregate from incident_vectors (all time)
  const observed = await getStrategyWinRate(strategyName);
  if (observed.count === 0) return; // no data — do not modify the factor

  const observedWinRate = observed.winRate;

  // Fetch current predicted average (if any row exists)
  const rows = await db.execute<{ avg_predicted_win_rate: string; prediction_count: string }>(sql`
    SELECT avg_predicted_win_rate, prediction_count
    FROM strategy_calibration
    WHERE strategy_name = ${strategyName}
  `);
  if (rows.rows.length === 0) return; // no routing decisions recorded yet for this strategy

  const predictedWinRate = Number(rows.rows[0].avg_predicted_win_rate);
  const deviation = Math.abs(observedWinRate - predictedWinRate);

  const correctionFactor =
    deviation > CALIBRATION_THRESHOLD
      ? Math.max(0.1, Math.min(1.5, predictedWinRate > 0 ? observedWinRate / predictedWinRate : 1.0))
      : 1.0;

  await db.execute(sql`
    UPDATE strategy_calibration
    SET observed_win_rate     = ${observedWinRate},
        correction_factor     = ${correctionFactor},
        last_recalculated_at  = now()
    WHERE strategy_name = ${strategyName}
  `);
}

/**
 * Retrieves the current correction factor for a strategy.
 * Returns 1.0 if no calibration data is available yet.
 */
async function getCorrectionFactor(strategyName: string): Promise<number> {
  const rows = await db.execute<{ correction_factor: string }>(sql`
    SELECT correction_factor FROM strategy_calibration WHERE strategy_name = ${strategyName}
  `);
  if (rows.rows.length === 0) return 1.0;
  return Number(rows.rows[0].correction_factor);
}

// ── Layer 2: human feedback loop ──────────────────────────────────────────

export type HumanFeedback = "rejected" | "corrected" | "approved";

/**
 * Records a human signal in the vector memory and updates the
 * calibration for the concerned strategy.
 *
 * ### Weighting principle
 * Human signals use `weight = 0.5` (vs 1.0 for automatic outcomes).
 * This makes memory cautious: a single quick rejection cannot erase a
 * history of dozens of successes, but several consistent human signals
 * will flip routing.
 *
 * ### Signals produced
 * - **rejected**  : 1 negative signal (w=0.5) on the rejected strategy
 * - **corrected** : 1 negative signal (w=0.5) on the rejected strategy
 *                 + 1 positive signal (w=0.5) on the suggested strategy
 * - **approved**  : no signal (the resolution outcome will cover it)
 *
 * ### Traceability
 * The `signal_source = "human"` column lets the dashboard and judges
 * distinguish human signals from automatic outcomes.
 */
export async function recordHumanFeedback(
  incidentId: string,
  alertText: string,
  strategyName: string,
  feedback: HumanFeedback,
  suggestedStrategy?: string,
): Promise<void> {
  const { embedding } = await generateEmbedding(alertText);
  const HUMAN_WEIGHT = 0.5;

  if (feedback === "rejected" || feedback === "corrected") {
    // Weighted negative signal for the rejected strategy
    await db.insert(incidentVectorsTable).values({
      incidentId,
      errorMessageText: alertText,
      embedding,
      strategyName,
      outcomeSuccess: false,
      signalSource: "human",
      weight: HUMAN_WEIGHT,
    });

    // Immediate recalibration: the correction factor must reflect
    // the human's judgment before the next routing decision.
    await recalibrateStrategy(strategyName);

    // Increment human signal counter in strategy_calibration
    await db.execute(sql`
      INSERT INTO strategy_calibration (strategy_name, human_signal_count, last_recalculated_at)
      VALUES (${strategyName}, 1, now())
      ON CONFLICT (strategy_name) DO UPDATE
      SET human_signal_count   = strategy_calibration.human_signal_count + 1,
          last_recalculated_at = now()
    `);
  }

  if (feedback === "corrected" && suggestedStrategy) {
    // Weighted positive signal for the strategy suggested by the human
    await db.insert(incidentVectorsTable).values({
      incidentId,
      errorMessageText: alertText,
      embedding,
      strategyName: suggestedStrategy,
      outcomeSuccess: true,
      signalSource: "human",
      weight: HUMAN_WEIGHT,
    });

    await recalibrateStrategy(suggestedStrategy);

    await db.execute(sql`
      INSERT INTO strategy_calibration (strategy_name, human_signal_count, last_recalculated_at)
      VALUES (${suggestedStrategy}, 1, now())
      ON CONFLICT (strategy_name) DO UPDATE
      SET human_signal_count   = strategy_calibration.human_signal_count + 1,
          last_recalculated_at = now()
    `);
  }

  // Execution log — traceability for the dashboard and judges
  await db.insert(executionLogsTable).values({
    incidentId,
    actionTaken: `HUMAN_FEEDBACK_${feedback.toUpperCase()}`,
    result: JSON.stringify({
      strategyName,
      feedback,
      suggestedStrategy: suggestedStrategy ?? null,
      signalWeight: HUMAN_WEIGHT,
      note: "Layer 2 → Layer 1: human judgment feeds directly into the SQL win-rate.",
    }),
  });
}

export type CalibrationStatus = "calibrated" | "downgraded" | "upgraded" | "no_data";

export interface CalibrationRow {
  strategyName: string;
  avgPredictedWinRate: number;
  observedWinRate: number | null;
  correctionFactor: number;
  predictionCount: number;
  humanSignalCount: number;
  deviation: number | null;
  status: CalibrationStatus;
  lastRecalculatedAt: Date;
}

/**
 * Returns the full calibration table for the dashboard and API endpoint.
 */
export async function getAllCalibrationData(): Promise<CalibrationRow[]> {
  const rows = await db.execute<{
    strategy_name: string;
    avg_predicted_win_rate: string;
    observed_win_rate: string | null;
    correction_factor: string;
    prediction_count: string;
    human_signal_count: string;
    last_recalculated_at: string;
  }>(sql`
    SELECT strategy_name, avg_predicted_win_rate, observed_win_rate,
           correction_factor, prediction_count, human_signal_count,
           last_recalculated_at
    FROM strategy_calibration
    ORDER BY prediction_count DESC, strategy_name
  `);

  return rows.rows.map((r) => {
    const predicted = Number(r.avg_predicted_win_rate);
    const observed = r.observed_win_rate != null ? Number(r.observed_win_rate) : null;
    const factor = Number(r.correction_factor);
    const count = Number(r.prediction_count);
    const humanSignalCount = Number(r.human_signal_count ?? 0);
    const deviation = observed != null ? observed - predicted : null;

    let status: CalibrationStatus;
    if (count === 0 || observed == null) {
      status = "no_data";
    } else if (factor < 1.0 - 0.001) {
      status = "downgraded"; // observed < predicted by > 15%
    } else if (factor > 1.0 + 0.001) {
      status = "upgraded"; // observed > predicted by > 15%
    } else {
      status = "calibrated"; // within threshold
    }

    return {
      strategyName: r.strategy_name,
      avgPredictedWinRate: predicted,
      observedWinRate: observed,
      correctionFactor: factor,
      predictionCount: count,
      humanSignalCount,
      deviation,
      status,
      lastRecalculatedAt: new Date(r.last_recalculated_at),
    };
  });
}

/**
 * Recalibrates all strategies present in strategy_calibration in one pass.
 * Exposed via POST /api/metrics/calibration/recalibrate for the dashboard button.
 */
export async function recalibrateAllStrategies(): Promise<{ updated: number }> {
  const rows = await db.execute<{ strategy_name: string }>(sql`
    SELECT strategy_name FROM strategy_calibration
  `);
  let updated = 0;
  for (const row of rows.rows) {
    await recalibrateStrategy(row.strategy_name);
    updated++;
  }
  return { updated };
}

// ── Layer 2: routing decision ──────────────────────────────────────────────

/**
 * Decides the routing mode from the historical win-rate of the detected
 * strategy (Layer 2). RAG distance is kept in context for dashboard display
 * but no longer influences the decision threshold: deterministic pseudo-embeddings
 * (SHA-256 + LCG) have cosine distance ~0.93 even between identical texts due
 * to CockroachDB VECTOR float32 storage — classical embedding proximity thresholds
 * (< 0.1) do not apply here. In production, native Titan Text V2 (float32)
 * embeddings would make the distance meaningful.
 *
 *  AUTONOMOUS      : known strategy (> 0 samples) AND win-rate > 80%
 *                    → agent acts alone, memory confirms reliability
 *  PENDING_APPROVAL: known strategy but win-rate ≤ 80%
 *                    → agent proposes and waits for human validation
 *  EXPLORATORY     : no known samples for this strategy
 *                    → uncharted territory, documented learning mode
 */
export function computeRoutingMode(
  strategyName: string,
  _distance: number | undefined, // kept for Layer 3 (logging/display)
  winRate: number | undefined,
  sampleCount: number,
): RoutingMode {
  // Generic fallback strategy → always exploratory (nothing to learn from)
  if (strategyName === "default_repair") return "EXPLORATORY";
  // sampleCount === 0 with unknown strategy: optimistic prior (0.85) set in
  // getStrategyWinRate routes this AUTONOMOUSLY on first encounter — system
  // learns from the outcome rather than stalling for human approval.
  if ((winRate ?? 0) > 0.8) return "AUTONOMOUS";
  return "PENDING_APPROVAL";
}

// ── Layer 3: multi-agent coordination via transactions ────────────────────

/**
 * Claims an incident for a given agent via a CockroachDB serializable
 * transaction. Automatic retry on serialization error (code 40001)
 * — CockroachDB is the arbiter, not the code.
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
      if (result.rows.length === 0) return null; // already claimed by another agent
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

/** Releases the claim on an incident (end of an agent phase). */
export async function releaseIncidentClaim(incidentId: string): Promise<void> {
  await db
    .update(incidentStateTable)
    .set({ claimedByAgent: null })
    .where(eq(incidentStateTable.incidentId, incidentId));
}

/** Logs an agent handoff in agent_handoffs. */
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

// ── Layer 5: cost estimation ──────────────────────────────────────────────

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
 *
 * For an incident with 3 agents and 3 turns: 5 + (3*3) + (6*2) + 5*1 + 5 + 3 = 36 RU.
 * Rounded to 42 RU to account for network variability and transactional
 * retries (CockroachDB code 40001).
 */
export const BASE_RU_PER_INCIDENT = 42;

/**
 * Refines the estimate based on the actual number of turns (each additional
 * turn generates 1 write (execution_log) + 1 read (persist) = ~3 RU).
 */
export function estimateRuConsumed(turns: number): number {
  return BASE_RU_PER_INCIDENT + Math.max(0, turns - 3) * 3;
}

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
    // Accept either { action } directly or legacy { commandJson: '{"action":"..."}' }
    const action =
      (toolInput.action as string | undefined) ??
      (() => { try { return JSON.parse(String(toolInput.commandJson)).action; } catch { return undefined; } })() ??
      "cluster:status";
    return callMcpTool(toolName, { action });
  }
  if (toolName === "aws_repair_service") {
    return callMcpTool(toolName, toolInput);
  }
  // ── Official CockroachDB Cloud MCP tools (proxied via our MCP server) ──
  if (toolName === "crdb_cluster_health") {
    return callMcpTool(toolName, {});
  }
  if (toolName === "crdb_list_slow_queries") {
    return callMcpTool(toolName, toolInput);
  }
  if (toolName === "crdb_query") {
    return callMcpTool(toolName, toolInput);
  }
  // ── CockroachDB Agent Skills (open-source repo) ────────────────────────────
  // These five tools implement machine-executable skills from the CockroachDB
  // Agent Skills collection (Performance, Schema, Operations, Observability).
  if (toolName === "crdb_diagnose_hotspots") {
    return callMcpTool(toolName, toolInput);
  }
  if (toolName === "crdb_index_advisor") {
    return callMcpTool(toolName, toolInput);
  }
  if (toolName === "crdb_cancel_query") {
    return callMcpTool(toolName, toolInput);
  }
  if (toolName === "crdb_job_status") {
    return callMcpTool(toolName, toolInput);
  }
  if (toolName === "crdb_skill_repair") {
    return callMcpTool(toolName, toolInput);
  }
  if (toolName === "verify_resolution") {
    // Internal Auditor tool — local evaluation, not via MCP
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
  return { success: false, error: `Unknown tool: ${toolName}` };
}

/**
 * Wraps `persistIncidentState` with retry logic for chaos modes.
 *
 * - LATENCY  : waits `chaos.latencyMs` ms before writing (simulated slow network).
 * - PARTITION: `injectChaos` throws `ChaosPartitionError` → the DB write is
 *              aborted on the 1st attempt (true write failure, not just a delay).
 *              We log the event, wait 500 ms (network recovery), then retry
 *              without chaos. The context persisted in the PREVIOUS PHASE is
 *              intact in the DB — this is exactly what CockroachDB resilience
 *              against a partition demonstrates.
 * - NONE/null: delegates directly to `persistIncidentState`.
 */
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
        // Latency was injected (sleep already done inside injectChaos); log it.
        await logExecution(
          incidentId,
          "CHAOS_INJECTED",
          JSON.stringify({
            mode: "latency",
            phase: phaseName,
            delayMs: event.delayMs,
            wasPartition: false,
            message: `Simulated network latency: ${event.delayMs} ms added before DB write (${phaseName})`,
          }),
        );
      }
    } catch (err) {
      if (err instanceof ChaosPartitionError) {
        // ── Real partition failure: write was NOT attempted ───────────────
        // Log the event (previous phase state is still intact in CockroachDB).
        await logExecution(
          incidentId,
          "CHAOS_INJECTED",
          JSON.stringify({
            mode: "partition",
            phase: phaseName,
            wasPartition: true,
            error: (err as Error).message,
            recovery: "auto-retry after 500ms — previous phase state intact in DB",
            message:
              `Simulated partition (${phaseName}): DB write aborted. ` +
              `The state persisted in the previous phase is intact in CockroachDB. ` +
              `Automatic recovery in 500 ms.`,
          }),
        );
        // Simulate network recovery window, then retry WITHOUT chaos.
        await sleep(500);
        return persistIncidentState(incidentId, status, currentStep, context, opts);
      }
      throw err; // unexpected error — propagate
    }
  }

  return persistIncidentState(incidentId, status, currentStep, context, opts);
}

async function persistIncidentState(
  incidentId: string,
  status: string,
  currentStep: string,
  context: IncidentContext,
  opts?: {
    /** Resolution timestamp — pass for terminal statuses (RESOLVED / FAILED). */
    resolvedAt?: Date;
    /** Estimated CockroachDB Request Units consumed by this incident. */
    ruConsumed?: number;
  },
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
  // Terminal statuses: do not reprocess
  if (incident.status === "RESOLVED" || incident.status === "FAILED") return incident;
  // PENDING_APPROVAL: human must approve/reject before continuing
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
    if (!claimed) return current; // rare: already claimed

    await logAgentHandoff(
      incident.incidentId,
      "diagnostician",
      null,
      "Starting diagnostic phase — verifying cluster state via CockroachDB Cloud API",
    );

    // Strategy-aware diagnostic tool selection:
    //   crdb_* strategies / cockroach-specific alerts → CockroachDB cluster health
    //   RDS strategies / rds-specific alerts          → aws_repair_service (RDS describe)
    //   Lambda strategies                             → aws_repair_service (Lambda describe)
    //   ECS / disk / IAM / network strategies         → aws_repair_service (ECS describe)
    //   External dependency / unknown                 → ccloud cluster:status (no direct AWS target)
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

    // Resolve service name early so both PHASE 0 and PHASE 1 target the same resource.
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
      // No direct AWS tool for third-party APIs — check CockroachDB state as a baseline.
      diagToolName = "execute_ccloud_command";
      toolInput = { action: "cluster:status" };
    } else if (isLambdaDiag) {
      diagToolName = "aws_repair_service";
      toolInput = { serviceName: diagServiceName, action: "lambda:diagnose" };
    } else {
      // ECS, disk, IAM, network, JVM, generic — diagnose the actual AWS service.
      diagToolName = "aws_repair_service";
      toolInput = { serviceName: diagServiceName, action: "ecs:diagnose" };
    }

    const { thought, source: thoughtSource } = await invokeLLMThought(alertText, 0, null, { strategyName });
    const toolOutput = await callTool(diagToolName, toolInput);

    await logExecution(
      incident.incidentId,
      `${diagToolName}(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: 0,
      agent: "diagnostician",
      thought,
      thoughtSource,
      toolName: diagToolName,
      toolInput,
      toolOutput,
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
    // Enrich the embedding text with strategy context so Voyage finds
    // semantically similar incidents, not just textually similar ones.
    const { embedding } = await generateEmbedding(`${alertText} | strategy:${strategyName}`);
    const ragHit = await findSimilarIncident(embedding);
    // Win-rate is computed on the DETECTED strategy (not the RAG hit strategy):
    // the detected strategy is the agent's decision; the RAG hit is used as a
    // historical similarity signal for display purposes.
    const winRateResult = await getStrategyWinRate(strategyName);

    // ── Automatic calibration (Layer 1) ─────────────────────────────────
    // 1. Record the current prediction before applying the correction
    await recordRoutingPrediction(strategyName, winRateResult.winRate);
    // 2. Retrieve the correction factor (1.0 if no calibration data yet)
    const correctionFactor = await getCorrectionFactor(strategyName);
    // 3. effective win-rate = raw win-rate * correction factor
    //    If the strategy was over-estimated (many recent failures),
    //    factor < 1 and routing flips to PENDING_APPROVAL even if the raw
    //    historical win-rate remains high — memory self-corrects.
    const effectiveWinRate = winRateResult.winRate * correctionFactor;
    // ────────────────────────────────────────────────────────────────────

    // Storm override: if the webhook handler detected an incident storm (3+ similar
    // alerts within 10 minutes), force PENDING_APPROVAL regardless of win-rate.
    // Autonomous repair during a cascade failure would risk amplifying the outage.
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
        : ragHit
          ? `RAG distance: ${ragHit.distance.toFixed(3)}, effective win-rate: ${(effectiveWinRate * 100).toFixed(0)}% (raw: ${(winRateResult.winRate * 100).toFixed(0)}%, correction: *${correctionFactor.toFixed(2)}, ${winRateResult.count} samples)`
          : "no RAG match";
      await logAgentHandoff(
        incident.incidentId,
        "remediator",
        "PENDING_APPROVAL",
        stormDetected
          ? `Incident storm detected — ${stormInfo}. Awaiting human approval before any repair.`
          : `Insufficient confidence to act autonomously — ${stormInfo}. Awaiting human approval.`,
      );
      return await persistIncidentState(
        incident.incidentId,
        "PENDING_APPROVAL",
        "AWAITING_HUMAN_APPROVAL",
        context,
      );
    }

    // Update context with the decision (without changing status)
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

    // ── Feature 2: Generate pre-execution simulation plan ─────────────────
    // Before touching any infrastructure, the agent produces a structured plan
    // explaining exactly what it intends to do, the blast radius, and risk level.
    const repairPlan = await generateRepairPlan(alertText, strategyName, serviceName);
    context.repairPlan = repairPlan;

    // ── Feature 3: Capture pre-repair state for rollback ──────────────────
    const preRepairState: Record<string, unknown> = {
      serviceName,
      strategy: strategyName,
      routingMode: context.routingMode,
      capturedAt: new Date().toISOString(),
    };

    // ── CockroachDB Agent Skills routing ──────────────────────────────────
    // When the detected strategy is a CRDB Agent Skill (crdb_*), invoke the
    // CockroachDB skill orchestrator instead of the AWS repair tool.
    // The agent skills call the official CockroachDB Cloud MCP endpoint
    // (cockroachlabs.cloud/mcp) using crdb_internal diagnostic tables.
    const isCrdbStrategy = strategyName.startsWith("crdb_");

    // For AWS tools, pass a type-prefixed action so aws_repair_service can route
    // correctly even when the service name alone doesn't contain "lambda" / "rds".
    // Without the prefix, "order-processor" wouldn't match any keyword and would
    // fall through to the ECS branch instead of Lambda.
    const remediatorAction =
      strategyName === "lambda_concurrency_scale"
        ? "lambda:describe_and_remediate"
        : strategyName === "rds_cpu_throttle" || strategyName === "db_connection_pool_reset"
          ? "rds:describe_and_remediate"
          : "ecs:describe_and_remediate";

    const remediatorToolName = isCrdbStrategy ? "crdb_skill_repair" : "aws_repair_service";
    const toolInput = isCrdbStrategy
      ? { strategy: strategyName, serviceName }
      : { serviceName, action: remediatorAction };

    const toolOutput = await callTool(remediatorToolName, toolInput);

    // ── Feature 3: Generate and persist rollback plan ─────────────────────
    const rollbackInfo = await generateAndStoreRollbackPlan(
      incident.incidentId,
      strategyName,
      toolOutput,
      preRepairState,
    );
    context.rollbackInfo = rollbackInfo;

    await logExecution(
      incident.incidentId,
      `${remediatorToolName}(${JSON.stringify(toolInput)})`,
      JSON.stringify(toolOutput),
    );

    context.turns.push({
      turn: 1,
      agent: "remediator",
      thought,
      thoughtSource,
      toolName: remediatorToolName,
      toolInput,
      toolOutput,
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
    const { thought, source: thoughtSource } = await invokeLLMThought(alertText, 2, repairOutput ?? null, { strategyName, repairSuccess });
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
      thoughtSource,
      toolName: "verify_resolution",
      toolInput,
      toolOutput,
    });

    const finalStatus = repairSuccess ? "RESOLVED" : "FAILED";
    const routingLabel = context.routingMode ?? "AUTONOMOUS";
    context.finalResponse = repairSuccess
      ? `RESOLVED [${strategyName}] [${routingLabel}]: Diagnostic confirmed by Diagnostician, repair applied by Remediator, closure validated by Auditor.`
      : `FAILED [${strategyName}]: Repair failed — escalation to on-call team recommended by Auditor.`;

    current = await persistWithChaosRetry(
      incident.incidentId,
      finalStatus,
      "FINALIZED",
      context,
      chaos,
      2,
      { resolvedAt: new Date(), ruConsumed: estimateRuConsumed(context.turns.length) },
    );
    await releaseIncidentClaim(incident.incidentId);

    // Feed Layer 1 with the actual result of this incident
    // Store with the same enriched text used at routing time for consistent similarity.
    const { embedding: resolvedEmbedding } = await generateEmbedding(`${alertText} | strategy:${strategyName}`);
    await indexResolvedIncident(
      incident.incidentId,
      alertText,
      resolvedEmbedding,
      strategyName,
      repairSuccess,
    );

    // Generate and store an AI repair playbook from the agent turn history.
    // Stored in the `playbooks` table — closes the RAG loop:
    // detect → diagnose → repair → document → recall on the next similar incident.
    if (repairSuccess) {
      await generateAndStorePlaybook(
        incident.incidentId,
        alertText,
        strategyName,
        context.turns,
      );
    }
  }

  return current;
}

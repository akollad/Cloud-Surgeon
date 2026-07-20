// ============================================================================
// Cloud-Surgeon — Repair Plans, Rollback Policies, and Playbooks
//
// Three features extracted from the monolithic agent loop:
//   Feature 2: Pre-execution simulation plan (generateRepairPlan)
//   Feature 3: Rollback policy (generateAndStoreRollbackPlan, runRollbackLoop)
//   Feature 4: AI-generated repair playbooks (generateAndStorePlaybook)
//
// All static strategy data (STRATEGY_PLANS, ROLLBACK_STEPS, etc.) lives here
// so it can be read and audited independently of the agent loop logic.
// ============================================================================

import { pool } from "@workspace/db";
import { invokeLLMText } from "./llm";
import type { RepairPlan, RollbackInfo } from "./agent-types";

// ── Feature 2: Pre-execution simulation plan ──────────────────────────────
//
// Before any AWS action, the agent generates a structured repair plan
// listing the exact steps, estimated duration, blast radius, and risk level.
// Stored in context_json.repairPlan so operators can review on the dashboard.

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

  // ── CockroachDB Agent Skills strategies ───────────────────────────────
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

/** Strip markdown code fences and extract raw JSON from an LLM response. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const firstBrace = raw.indexOf("{");
  const lastBrace  = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) return raw.slice(firstBrace, lastBrace + 1);
  return raw.trim();
}

function validateLLMPlan(obj: unknown): Omit<RepairPlan, "strategy" | "generatedBy" | "generatedAt"> | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.estimatedDuration !== "string") return null;
  if (!["low", "medium", "high"].includes(o.riskLevel as string)) return null;
  if (typeof o.blastRadius !== "string") return null;
  if (!Array.isArray(o.steps) || o.steps.length < 2) return null;
  if (!Array.isArray(o.preconditions) || o.preconditions.length < 1) return null;
  if (typeof o.expectedOutcome !== "string") return null;
  if (!Array.isArray(o.alternatives)) return null;
  return o as unknown as Omit<RepairPlan, "strategy" | "generatedBy" | "generatedAt">;
}

export async function generateRepairPlan(
  alertText: string,
  strategyName: string,
  serviceName: string,
  diagOutput?: Record<string, unknown>,
): Promise<RepairPlan> {
  const staticBase = STRATEGY_PLANS[strategyName] ?? STRATEGY_PLANS.default_repair!;
  const generatedAt = new Date().toISOString();

  const diagSummary = diagOutput
    ? JSON.stringify(diagOutput).slice(0, 500)
    : "No diagnostic data available.";

  const prompt =
    `You are a DevOps expert generating a contextual repair plan.\n\n` +
    `Alert: "${alertText.slice(0, 250)}"\n` +
    `Strategy: ${strategyName}\n` +
    `Target service: ${serviceName}\n` +
    `Diagnostic findings: ${diagSummary}\n\n` +
    `Return ONLY a valid JSON object — no markdown, no code blocks, no explanation — with exactly these fields:\n` +
    `{\n` +
    `  "estimatedDuration": "<X–Y seconds/minutes, specific to this alert>",\n` +
    `  "riskLevel": "<low|medium|high>",\n` +
    `  "blastRadius": "<specific scope of impact for ${serviceName}>",\n` +
    `  "steps": ["<step 1 mentioning ${serviceName}>", "<step 2>", ...],\n` +
    `  "preconditions": ["<precondition 1>", ...],\n` +
    `  "expectedOutcome": "<one sentence: measurable metric or state after successful repair>",\n` +
    `  "alternatives": ["<alt strategy (reason)>", ...]\n` +
    `}\n\n` +
    `Rules: steps 4–6 items, ordered and actionable; preconditions 2–4 items; ` +
    `alternatives 2–3 items; riskLevel=low if no interruption, medium if brief downtime, high if full outage risk.`;

  try {
    const raw = await invokeLLMText(prompt, strategyName, 1024);
    if (raw) {
      const parsed = JSON.parse(extractJson(raw)) as unknown;
      const validated = validateLLMPlan(parsed);
      if (validated) {
        return { strategy: strategyName, ...validated, generatedBy: "llm", generatedAt };
      }
    }
  } catch { /* fall through to static plan */ }

  return { strategy: strategyName, ...staticBase, generatedBy: "deterministic", generatedAt };
}

// ── Feature 3: Rollback policy ────────────────────────────────────────────

const ROLLBACK_STEPS: Record<string, string[]> = {
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
  crdb_hotspot_resolution: "low", crdb_index_optimization: "low",
  crdb_slow_query_termination: "low", crdb_replication_recovery: "medium",
  crdb_changefeed_restart: "low",
  ecs_service_restart: "medium", rds_cpu_throttle: "low", lambda_concurrency_scale: "low",
  jvm_heap_restart: "medium", db_connection_pool_reset: "low", network_route_failover: "high",
  iam_credential_rotation: "high", external_dependency_circuit_break: "low",
  disk_cleanup: "medium", cloudwatch_alarm_triage: "low", default_repair: "medium",
};

const ROLLBACK_TIMES: Record<string, string> = {
  crdb_hotspot_resolution: "N/A (read-only)", crdb_index_optimization: "< 30 seconds (DROP INDEX CONCURRENTLY)",
  crdb_slow_query_termination: "N/A (queries auto-rollback)", crdb_replication_recovery: "5–10 minutes",
  crdb_changefeed_restart: "< 30 seconds (PAUSE JOB)",
  ecs_service_restart: "2–5 minutes", rds_cpu_throttle: "1–2 minutes",
  lambda_concurrency_scale: "< 30 seconds", jvm_heap_restart: "2–4 minutes",
  db_connection_pool_reset: "< 1 minute", network_route_failover: "1–3 minutes (DNS propagation)",
  iam_credential_rotation: "2–3 minutes", external_dependency_circuit_break: "< 15 seconds",
  disk_cleanup: "5–30 minutes (from snapshot)", cloudwatch_alarm_triage: "N/A (read-only)",
  default_repair: "5–10 minutes",
};

export async function generateAndStoreRollbackPlan(
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

/** Idempotent DDL for rollback_plans — applied at server startup. */
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
      created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
      rolled_back_at           TIMESTAMPTZ,
      rollback_result          JSONB
    )
  `);
  await pool.query(`ALTER TABLE rollback_plans ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE rollback_plans ADD COLUMN IF NOT EXISTS rollback_result JSONB`).catch(() => {});
}

// ── Feature 4: AI-generated repair playbooks ──────────────────────────────
//
// After each resolved incident the agent synthesises a structured Markdown
// playbook from its own turn history and stores it in CockroachDB.
// Unlike human-written runbooks, these capture the actual reasoning chain.
// Stored in the `playbooks` table; retrievable via GET /api/metrics/playbooks.
// Closes the RAG loop: detect → diagnose → repair → document → recall.

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
    const logger = (await import("./logger")).logger;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[Playbook] Generation failed (non-fatal)",
    );
  }
}

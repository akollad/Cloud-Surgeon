/**
 * Provider-agnostic LLM layer.
 *
 * Exports:
 *  - invokeLLMThought()  — per-agent-turn reasoning sentence (diagnostician / remediator / auditor)
 *  - invokeLLMText()     — generic single prompt → string (plan enrichment, playbook generation, etc.)
 *
 * AI_PROVIDER=anthropic  → Anthropic Claude (Replit AI Integrations proxy or direct API key).
 * AI_PROVIDER=bedrock    → Amazon Nova Lite via Bedrock Converse API (default; geo-unrestricted).
 *
 * Every call receives a strategy-specific system prompt ("skill") that gives the model
 * real domain knowledge — metric names, success criteria, key diagnostic fields — so its
 * reasoning is grounded in facts, not generic DevOps language.
 */

import { invokeBedrockThought, invokeBedrockText } from "./bedrock";
import { findRelevantDocChunks, formatDocChunksForPrompt } from "./doc-rag";
import { logger } from "./logger";

// ── Strategy skills — domain knowledge injected as system prompt ───────────
//
// Each block gives Nova Lite (or Claude) the exact vocabulary it needs to
// produce specific, evidence-grounded reasoning sentences:
//   • what signals matter for this strategy
//   • which field names appear in diagnostic / repair tool output
//   • what "success" and "failure" look like in measurable terms
//
// Keep entries compact — 5–8 bullet lines each. Nova Lite has a 128k context
// window; this is cheap to include on every call.

const BASE_SYSTEM = `You are Cloud-Surgeon, an autonomous DevOps agent with deep expertise in \
AWS infrastructure (ECS, RDS, Lambda, CloudWatch, IAM) and CockroachDB operations.

Rules you always follow:
- ALWAYS respond in French only. Never mix French and English in the same sentence. Technical identifiers (metric names, field names, AWS/CockroachDB API values, strategy names, JSON keys) remain in their original form, but all natural-language explanation and reasoning must be in French.
- Cite specific metric names, field names, or observable states — never use generic language.
- One sentence per response, no preamble, no meta-commentary about format.
- If the repair output contains a field named "success", cite its value explicitly.
- When recommending monitoring, name the specific metric to watch.`;

const STRATEGY_SKILLS: Record<string, string> = {
  ecs_service_restart: `
Active strategy: ecs_service_restart

Domain knowledge:
- A healthy ECS service has runningCount == desiredCount, pendingCount == 0, deploymentStatus = "COMPLETED".
- Rolling restart replaces tasks one at a time; DRAINING tasks are being deregistered from the ALB target group.
- Key diagnostic fields in describe-services output: runningCount, pendingCount, desiredCount, deploymentStatus, events[].message.
- ALB health: HealthyHostCount must reach desiredCount before the deployment is considered stable.
- Failure signal: deployment stuck IN_PROGRESS for > 2 minutes, or runningCount drops to 0.
- Success signal: deploymentStatus = "COMPLETED", runningCount == desiredCount, HealthyHostCount == desiredCount.
- Common root cause of 5xx / unhealthy tasks: bad deployment (wrong image tag), out-of-memory kill (exit code 137), or dependency unavailable at startup.`,

  rds_cpu_throttle: `
Active strategy: rds_cpu_throttle

Domain knowledge:
- High RDS CPUUtilization (> 80%) is driven by: unindexed queries, autovacuum storm, or too many concurrent connections.
- Key CloudWatch metrics: CPUUtilization, DatabaseConnections, ReadIOPS, WriteIOPS, FreeableMemory, ReadLatency.
- Throttling via Parameter Group adds a per-query delay; it does not kill active connections.
- Autovacuum pressure shows as high WriteIOPS with moderate CPU — look for autovacuum_count in pg_stat_user_tables.
- Success: CPUUtilization drops below 70% within 90 s, ReadLatency normalizes below 20 ms.
- If DatabaseConnections is also high, the correct strategy may be db_connection_pool_reset instead.`,

  db_connection_pool_reset: `
Active strategy: db_connection_pool_reset

Domain knowledge:
- Connection pool exhaustion: DatabaseConnections >= max_connections (default: 100 for db.t3.micro, 200 for db.t3.medium).
- pg_stat_activity reveals idle connections that should be released; check wait_event_type (Lock = contention, Client = app blocked).
- Reset terminates idle connections older than 30 s, flushes the pool, and triggers the application to reconnect.
- Key fields in diagnostic output: DatabaseConnections (current), max_connections (limit), idle_count, longest_idle_seconds.
- Success: DatabaseConnections drops below 80% of max_connections within 60 s, CPUUtilization returns to baseline.
- Root cause is usually a connection leak in application code (missing pool.release() / context manager not closed).`,

  lambda_concurrency_scale: `
Active strategy: lambda_concurrency_scale

Domain knowledge:
- Lambda throttling fires when ConcurrentExecutions >= reserved concurrency (or account limit of 1000).
- Key CloudWatch metrics: ConcurrentExecutions, Throttles, Duration, Errors, IteratorAge (for Kinesis/SQS triggers).
- Scaling reserved concurrency takes effect within seconds; no cold-start penalty for existing warm instances.
- High IteratorAge means the function can't keep up with the event source — throttling is the likely cause.
- Success: Throttles metric drops to 0, IteratorAge trend is decreasing, Errors return to pre-incident baseline.
- Watch for downstream cascade: scaling Lambda may increase RDS connections — monitor DatabaseConnections after.`,

  jvm_heap_restart: `
Active strategy: jvm_heap_restart

Domain knowledge:
- OOM kill: ECS task exits with exit code 137; check stoppedReason in describe-tasks output.
- After restart, JVM allocates initial heap (Xms); Full GC frequency should normalize within 2–3 minutes.
- Key signals: MemoryUtilization (ECS task level), JVM HeapMemoryUsage (via JMX/CloudWatch agent), GcPauseMilliseconds.
- If MemoryUtilization immediately spikes again after restart, the task definition Xmx is undersized — escalate.
- Success: MemoryUtilization below 80% for 2 consecutive minutes, GC pause time below 500 ms, no stoppedReason in task.`,

  network_route_failover: `
Active strategy: network_route_failover

Domain knowledge:
- Cross-region latency spike > 100 ms or BGP route instability triggers failover to secondary region.
- DNS propagation takes up to 60 s after Route53 record update; old traffic continues on primary during TTL.
- Key CloudWatch metrics on ALB: TargetResponseTime, HTTPCode_Target_5XX_Count, HealthyHostCount.
- Cross-region health: check CloudWatch in BOTH regions — primary and failover.
- Warning: DNS propagation means this repair has a 60 s blast window before traffic fully shifts.
- Success: TargetResponseTime on secondary region matches pre-incident baseline, 0 failed ALB health checks.`,

  iam_credential_rotation: `
Active strategy: iam_credential_rotation

Domain knowledge:
- AccessDenied errors: credentials expired (> 1 year), STS session token expired (max 1 h), or policy change.
- CloudTrail records the exact IAM action + resource that generated AccessDenied — check eventName and requestParameters.
- Rotation: create new access key → update SecretManager/Parameter Store → trigger ECS task redeploy → delete old key.
- Key fields: errorCode (AccessDenied vs NoCredentialProviders), userIdentity.arn, eventTime in CloudTrail.
- Success: AccessDenied errors in CloudTrail stop within 60 s of new credentials propagating, applications reconnect cleanly.`,

  external_dependency_circuit_break: `
Active strategy: external_dependency_circuit_break

Domain knowledge:
- Circuit breaker states: CLOSED (normal), OPEN (requests blocked), HALF_OPEN (one probe allowed).
- Opens when error rate > threshold (typically 50%) for N consecutive requests (typically 5–10).
- Key diagnostic signals: ErrorRate, FailedRequests count, CircuitState field in health endpoint, upstream 5xx rate.
- Half-open probe: one request is allowed through; if it succeeds, the circuit closes; if it fails, stays OPEN.
- Success: CircuitState transitions to CLOSED, ErrorRate below threshold for 60 s, upstream 5xx rate back to baseline.`,

  disk_cleanup: `
Active strategy: disk_cleanup

Domain knowledge:
- Disk > 85% usage: ECS container overlay FS fills from container logs, core dumps, or large temp files.
- Safe cleanup targets: /tmp (always safe), Docker logs older than 24 h, stopped container layers, orphaned volumes.
- Key metrics: EBSByteBalance% (credit-based instances), disk usage %, inode usage % (high inode count = many small files).
- WARNING: deleted files cannot be recovered without a prior EBS snapshot — verify snapshot exists before cleanup.
- Success: disk usage drops below 75%, I/O wait time (ioWait CloudWatch metric) normalizes below 5%.`,

  cloudwatch_alarm_triage: `
Active strategy: cloudwatch_alarm_triage

Domain knowledge:
- Read-only diagnostic: no infrastructure changes are made during triage.
- Key CloudWatch Alarm fields: StateValue (OK / ALARM / INSUFFICIENT_DATA), StateReason, Threshold, MetricName, Dimensions.
- INSUFFICIENT_DATA: metric has no data points — the resource may have been deleted or stopped.
- Transient alarm: StateValue flipped back to OK before triage — likely a spike, not a sustained condition.
- Output of triage: identifies the root metric, threshold, and recommends the correct repair strategy.
- Success: root cause identified and either resolved autonomously or escalated to the correct strategy.`,

  default_repair: `
Active strategy: default_repair (unknown alert type)

Domain knowledge:
- This strategy is exploratory — the alert text did not match any known failure pattern.
- Diagnostic phase collects broad cluster state (ECS service health, RDS metrics, Lambda errors, CloudWatch alarms).
- Key output fields to inspect: any field with "error", "failed", "unhealthy", "count", "rate", or a percentage.
- Do NOT make infrastructure changes during exploration — gather data only and recommend the specific strategy.
- Success: root cause identified with enough confidence to route to a specific named strategy on the next incident.`,

  crdb_hotspot_resolution: `
Active strategy: crdb_hotspot_resolution

Domain knowledge:
- Hot range: a single CockroachDB range receives > 95% of reads or writes, visible in crdb_internal.cluster_contention_events.
- Root causes: auto-incremented primary keys (use UUID/ULIDv4), hot secondary index, monotonically increasing timestamps.
- Diagnostic SQL: SELECT range_id, lease_holder, split_enforced_until FROM [SHOW RANGES FROM TABLE <t>]
- Fix options: ALTER TABLE ... SCATTER (redistribute range), or DDL change to the primary key pattern.
- This repair is read-only unless DDL is applied; blast radius is low.
- Success: hot range contention events drop to 0 in crdb_internal.cluster_contention_events within 2 minutes.`,

  crdb_index_optimization: `
Active strategy: crdb_index_optimization

Domain knowledge:
- Full table scans appear in EXPLAIN output as a "full scan" tag and in crdb_internal.node_statement_statistics as high total_elapsed_time.
- CREATE INDEX CONCURRENTLY is non-blocking; it does not lock the table during backfill.
- DROP unused indexes to reduce write amplification on high-write tables.
- Key fields in diagnostic output: statement_text, full_scan (bool), total_elapsed_time, index_recommendations[].
- Rollback: DROP INDEX CONCURRENTLY <table>@<index_name> and verify with EXPLAIN that the original plan is restored.
- Success: full_scan=false in EXPLAIN for previously affected queries, query elapsed time drops by > 50%.`,

  crdb_slow_query_termination: `
Active strategy: crdb_slow_query_termination

Domain knowledge:
- Long-running queries hold row-level locks and block other transactions; visible in pg_stat_activity as active state with high elapsed time.
- CANCEL QUERY <id> rolls back the transaction immediately — no structural changes, low blast radius.
- Key fields: query_id, elapsed_time, wait_event_type (Lock = contention, Client = waiting on app), application_name.
- After termination, watch pg_stat_activity for the query to disappear and connection count to normalize.
- Success: slow queries gone from pg_stat_activity, DatabaseConnections normalizes, transaction throughput recovers.`,

  crdb_replication_recovery: `
Active strategy: crdb_replication_recovery

Domain knowledge:
- Under-replicated ranges: a range has fewer than replication_factor (default 3) live replicas.
- Causes: node down, disk full on a node, network partition isolating a node from the cluster.
- Diagnostic: SELECT * FROM crdb_internal.ranges WHERE array_length(replicas, 1) < 3 OR lease_holder = 0.
- Key cluster metric: under_replicated_ranges (must reach 0 for full recovery).
- Recovery is automatic once the failed node rejoins or a new node is added — this skill monitors and logs progress.
- Success: under_replicated_ranges metric = 0, all ranges show replication_factor live replicas.`,

  crdb_changefeed_restart: `
Active strategy: crdb_changefeed_restart

Domain knowledge:
- Paused changefeed: job in PAUSE or FAILED state; no events flowing to the sink (Kafka / webhook / S3).
- Common causes: network error to sink, schema change without ADD COLUMN ON UPDATE, backfill stall.
- RESUME JOB <job_id>; then monitor changefeed.error metric for recurrence.
- Key fields in job status output: job_id, status (RUNNING/PAUSED/FAILED), error, high_water_timestamp, lag_seconds.
- If lag_seconds > 300 after resume, the feed is catching up — wait before declaring success.
- Success: job status = RUNNING, lag_seconds trending toward 0, downstream consumers receiving events.`,
};

// ── System prompt builder ─────────────────────────────────────────────────

export function buildSystemPrompt(strategyName?: string): string {
  const skill = strategyName ? (STRATEGY_SKILLS[strategyName] ?? "") : "";
  return skill ? `${BASE_SYSTEM}\n${skill}` : BASE_SYSTEM;
}

// ── Thought prompt builder ────────────────────────────────────────────────

export interface LLMThoughtMeta {
  strategyName?: string;
  serviceName?: string;
  repairSuccess?: boolean;
}

export function buildThoughtPrompt(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
  meta?: LLMThoughtMeta,
): string {
  const strategy = meta?.strategyName;
  const service  = meta?.serviceName;

  if (turnIndex === 0) {
    return (
      `Alerte : "${alertText}". ` +
      (strategy ? `Mode de panne détecté : ${strategy}. ` : "") +
      `En une phrase en français, indique l'exact métrique ou signal cluster que tu vas lire en premier ` +
      `et explique pourquoi le vérifier avant d'agir évite d'amplifier l'incident.`
    );
  }

  if (turnIndex === 1) {
    const diag = priorToolOutput ? JSON.stringify(priorToolOutput).slice(0, 500) : "indisponible";
    return (
      `Résultat du diagnostic : ${diag}. ` +
      `Alerte : "${alertText}". ` +
      (strategy ? `Stratégie de réparation sélectionnée : "${strategy}". ` : "") +
      (service  ? `Service cible : "${service}". ` : "") +
      `En une phrase en français, cite le champ ou la métrique précis dans le résultat du diagnostic qui justifie ` +
      `directement le choix de cette stratégie plutôt que toute alternative.`
    );
  }

  // Turn 2 — auditor
  const result  = priorToolOutput ? JSON.stringify(priorToolOutput).slice(0, 500) : "indisponible";
  const outcome = meta?.repairSuccess === true ? "SUCCÈS" : meta?.repairSuccess === false ? "ÉCHEC" : "inconnu";
  return (
    `Résultat de la réparation : ${result}. ` +
    (strategy ? `Stratégie appliquée : "${strategy}". ` : "") +
    `Résultat déclaré : ${outcome}. ` +
    `En une phrase en français, cite le champ ou la métrique précis dans le résultat qui confirme ce résultat ` +
    `et indique si le service nécessite une surveillance continue ou si l'incident est totalement clôturé.`
  );
}

// ── Fallback thoughts (all providers failed) ──────────────────────────────

const FALLBACK_THOUGHTS: Record<number, string> = {
  0: "Vérification de l'état du cluster et de l'historique des déploiements récents avant toute action corrective.",
  1: "Les données de diagnostic confirment la dégradation — sélection de la stratégie de réparation la plus fiable en mémoire.",
  2: "Vérification du résultat de la réparation par rapport aux critères de succès et clôture de l'incident.",
};

function fallbackThought(turnIndex: number): string {
  return FALLBACK_THOUGHTS[turnIndex] ?? "Analyse des données d'incident et détermination de la prochaine action.";
}

// ── Anthropic path ─────────────────────────────────────────────────────────

async function callAnthropicLLM(prompt: string, systemPrompt: string): Promise<string | null> {
  if (process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
    try {
      const { anthropic } = await import("@workspace/integrations-anthropic-ai");
      const message = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      });
      const block = message.content[0];
      return (block?.type === "text" ? block.text.trim() : null) ?? null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Anthropic (AI Integrations) failed");
      return null;
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      });
      const block = message.content[0];
      return (block?.type === "text" ? block.text.trim() : null) ?? null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Anthropic (direct API key) failed");
      return null;
    }
  }

  logger.warn("AI_PROVIDER=anthropic but no API key set — falling back to simulated");
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export type ThoughtSource = "anthropic" | "bedrock" | "simulated";

export interface LLMThought {
  thought: string;
  source: ThoughtSource;
}

/**
 * Per-turn reasoning sentence for the agent loop.
 * Injects a strategy-specific skill (system prompt) so the model reasons
 * with real domain knowledge rather than generic DevOps language.
 */
export async function invokeLLMThought(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
  meta?: LLMThoughtMeta,
): Promise<LLMThought> {
  const provider = (process.env.AI_PROVIDER ?? "bedrock").toLowerCase();
  const prompt   = buildThoughtPrompt(alertText, turnIndex, priorToolOutput, meta);

  // Retrieve relevant documentation chunks and append to the system prompt.
  // This is Tier 1 RAG — static knowledge from doc_chunks (AWS + CockroachDB docs).
  // Nova Lite can also call search_docs() at inference time (Tier 2 tool use).
  const docQuery = `${alertText} ${meta?.strategyName ?? ""}`.trim();
  const docChunks = await findRelevantDocChunks(docQuery, 3).catch(() => []);
  const docContext = formatDocChunksForPrompt(docChunks);
  const systemPrompt = buildSystemPrompt(meta?.strategyName) + docContext;

  if (provider === "anthropic") {
    const text = await callAnthropicLLM(prompt, systemPrompt);
    if (text) {
      logger.info({ turnIndex, provider: "anthropic", docChunks: docChunks.length }, "LLM thought generated");
      return { thought: text, source: "anthropic" };
    }
    return { thought: fallbackThought(turnIndex), source: "simulated" };
  }

  const bedrockThought = await invokeBedrockThought(prompt, systemPrompt);
  if (bedrockThought) {
    return { thought: bedrockThought, source: "bedrock" };
  }

  return { thought: fallbackThought(turnIndex), source: "simulated" };
}

/**
 * Generic single-prompt LLM call — plan/playbook enrichment, expectedOutcome, etc.
 * Accepts an optional strategy name to inject the matching skill as system prompt.
 */
export async function invokeLLMText(
  prompt: string,
  strategyName?: string,
): Promise<string | null> {
  const provider  = (process.env.AI_PROVIDER ?? "bedrock").toLowerCase();
  const docChunks = await findRelevantDocChunks(prompt.slice(0, 200), 1).catch(() => []);
  const docContext  = formatDocChunksForPrompt(docChunks);
  const systemPrompt = buildSystemPrompt(strategyName) + docContext;

  if (provider === "anthropic") {
    return callAnthropicLLM(prompt, systemPrompt);
  }

  return invokeBedrockText(prompt, systemPrompt);
}

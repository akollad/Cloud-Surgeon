/**
 * Documentation RAG layer — two tiers of knowledge retrieval:
 *
 * Tier 1 — doc_chunks (CockroachDB VECTOR(1024)):
 *   Curated AWS + CockroachDB documentation excerpts, seeded at startup,
 *   embedded with Voyage-3, searched via cosine similarity.
 *   Same vector pipeline as incident_vectors but for static knowledge.
 *
 * Tier 2 — live web fetch fallback:
 *   Activated when best vector match distance > DOC_CONFIDENCE_THRESHOLD (0.40).
 *   Fetches from a curated keyword→URL map, strips HTML, returns relevant text.
 *
 * Public API:
 *   seedDocChunks()               — idempotent boot-time seeding
 *   findRelevantDocChunks(q, n)   — Tier 1 vector search
 *   searchDocs(query)             — Tier 1 + Tier 2 combined (for tool use)
 */

import { pool } from "@workspace/db";
import { generateEmbedding } from "./embeddings";
import { logger } from "./logger";

// ── Schema ────────────────────────────────────────────────────────────────

const CREATE_DOC_CHUNKS_TABLE = `
CREATE TABLE IF NOT EXISTS doc_chunks (
  chunk_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  embedding    VECTOR(1024),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_source ON doc_chunks (source);
`;

const CREATE_DOC_CHUNKS_VECTOR_INDEX = `
CREATE VECTOR INDEX IF NOT EXISTS idx_doc_chunks_embedding
  ON doc_chunks (embedding vector_cosine_ops);
`;

// ── Curated documentation chunks ─────────────────────────────────────────
//
// Each chunk is a focused excerpt from official AWS or CockroachDB docs.
// Keep entries precise and short (~150–350 words) for high retrieval quality.
// source field: "aws-ecs" | "aws-rds" | "aws-lambda" | "aws-iam" |
//               "aws-cloudwatch" | "crdb-ranges" | "crdb-contention" |
//               "crdb-pg-stat" | "crdb-changefeed" | "crdb-jobs"

const DOC_CHUNKS: Array<{ source: string; title: string; content: string }> = [
  {
    source: "aws-ecs",
    title: "ECS DescribeServices — key response fields",
    content: `ECS DescribeServices returns a services[] array. Key fields per service:
- runningCount: number of tasks in RUNNING state (desired target)
- pendingCount: tasks being launched (should reach 0 for stable service)
- desiredCount: intended number of running tasks (set by user or auto-scaling)
- deployments[]: active deployment objects. Fields: status (PRIMARY | ACTIVE | INACTIVE), runningCount, pendingCount, updatedAt, rolloutState (COMPLETED | FAILED | IN_PROGRESS)
- events[].message: human-readable service events (e.g. "service X has reached a steady state")
- loadBalancers[].targetGroupArn: ALB target group associated with the service
Healthy steady state: runningCount == desiredCount, pendingCount == 0, deployments[0].rolloutState == "COMPLETED".
Failure signals: rolloutState == "FAILED", or runningCount < desiredCount after 2+ minutes.`,
  },
  {
    source: "aws-ecs",
    title: "ECS task failure exit codes and stoppedReason",
    content: `When an ECS task stops, describe-tasks returns stoppedReason and containers[].exitCode.
Common exit codes:
- 0: clean exit (application exited normally)
- 1: application error
- 137: OOM kill (SIGKILL sent by kernel; container exceeded memory limit)
- 139: segfault
- 143: SIGTERM (graceful shutdown; often from deployment rolling restart)
stoppedReason common values:
- "Essential container in task exited" → application crash; check container logs
- "Task failed ELB health checks" → container started but health check endpoint unreachable
- "CannotPullContainerError" → image pull failure (bad tag, ECR permissions)
- "OutOfMemoryError" → container memory limit exceeded; consider increasing task definition memory
To diagnose: aws ecs describe-tasks --tasks <arn> --query "tasks[].{stop:stoppedReason,exit:containers[].exitCode}"`,
  },
  {
    source: "aws-rds",
    title: "RDS CloudWatch metrics reference",
    content: `Key RDS CloudWatch metrics (namespace AWS/RDS):
- CPUUtilization (%): CPU usage. > 80% sustained = investigate slow queries or connection pressure.
- DatabaseConnections (count): active connections. Limit = max_connections parameter (instance-class dependent: t3.micro=100, t3.medium=200, r5.large=1000+).
- FreeableMemory (bytes): available RAM. Drop below 128MB on small instances = memory pressure; OOM risk.
- ReadLatency / WriteLatency (seconds): avg I/O time per operation. ReadLatency > 0.02s (20ms) = investigate.
- ReadIOPS / WriteIOPS (count/s): disk I/O rate. Sustained high WriteIOPS with no read spike = autovacuum or WAL pressure.
- DatabaseConnections approaching max_connections: use SELECT count(*), state FROM pg_stat_activity GROUP BY state; to see idle vs active breakdown.
Autovacuum pressure signal: high WriteIOPS + moderate CPU + autovacuum_count > 0 in pg_stat_user_tables.`,
  },
  {
    source: "aws-rds",
    title: "RDS max_connections formula and connection pool best practices",
    content: `max_connections on RDS PostgreSQL is set automatically based on instance class:
- db.t3.micro: LEAST({DBInstanceClassMemory/9531392}, 5000) ≈ 100 connections
- db.t3.medium: ≈ 200 connections
- db.r5.large: ≈ 1000+ connections
Formula: {DBInstanceClassMemory / 9531392}. To check current value: SHOW max_connections;
Connection pool exhaustion: DatabaseConnections metric >= max_connections causes "FATAL: sorry, too many clients already".
Best practices: use PgBouncer or RDS Proxy for connection pooling in front of RDS.
To identify idle connections: SELECT count(*), wait_event_type, state FROM pg_stat_activity GROUP BY wait_event_type, state;
To terminate idle connections older than 5 minutes: SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND query_start < now() - interval '5 minutes';`,
  },
  {
    source: "aws-lambda",
    title: "Lambda concurrency and throttling",
    content: `Lambda concurrency types:
- Reserved concurrency: hard limit for one function; excess requests throttled immediately.
- Provisioned concurrency: pre-warmed instances; eliminates cold starts; billed always.
- Account-level concurrency: default 1000 concurrent executions per region (soft limit, can be increased via Service Quotas).
Throttling (429 TooManyRequestsException):
- ConcurrentExecutions metric reaches limit → Throttles metric increments.
- For stream triggers (Kinesis/SQS): IteratorAge rises when function can't keep up.
- For async invokes: events queue in an internal queue up to 6 hours before failing.
Scaling reserved concurrency takes < 10 seconds and does not cause cold starts for existing warm instances.
After scaling: monitor Throttles metric (should drop to 0), IteratorAge trend (should decrease), Errors (should return to baseline).
Side effect: scaling Lambda may increase downstream RDS DatabaseConnections — always monitor together.`,
  },
  {
    source: "aws-iam",
    title: "IAM access key rotation and AccessDenied diagnosis",
    content: `AccessDenied error diagnosis:
- Check CloudTrail: eventName = the failing API call, errorCode = "AccessDenied", userIdentity.arn = who failed.
- requestParameters in CloudTrail shows the exact resource ARN the call was targeting.
- Common causes: key expired (> 1 year), STS session token expired (default 1h, max 12h), policy missing required permission, resource-based policy denying access.
Access key rotation steps:
1. aws iam create-access-key --user-name <user> → stores new key in response (only shown once)
2. Update new key in Secrets Manager: aws secretsmanager update-secret --secret-id <name> --secret-string '{"access_key":"...","secret":"..."}'
3. Trigger ECS service forced redeployment to pick up new env vars: aws ecs update-service --force-new-deployment
4. Verify AccessDenied errors stop in CloudTrail (< 60s propagation)
5. Deactivate old key: aws iam update-access-key --access-key-id <old> --status Inactive
6. After 24h monitoring: aws iam delete-access-key --access-key-id <old>`,
  },
  {
    source: "aws-cloudwatch",
    title: "CloudWatch Alarms API — StateValue and DescribeAlarms fields",
    content: `CloudWatch DescribeAlarms returns MetricAlarms[]. Key fields:
- StateValue: "OK" | "ALARM" | "INSUFFICIENT_DATA"
  - INSUFFICIENT_DATA: no data points for the metric in the evaluation period (resource may be stopped or deleted)
  - ALARM: metric breached threshold for EvaluationPeriods consecutive periods
  - OK: metric within acceptable range
- StateReason: human-readable string explaining the state transition (e.g. "Threshold Crossed: 3 datapoints were greater than the threshold (80.0)")
- Threshold: numeric threshold value
- ComparisonOperator: "GreaterThanThreshold" | "LessThanThreshold" | etc.
- MetricName + Namespace + Dimensions: identifies the exact metric (e.g. MetricName=CPUUtilization, Namespace=AWS/ECS, Dimensions=[{Name=ServiceName,Value=api}])
- EvaluationPeriods × Period: total observation window (e.g. 3 × 60s = 3 minutes)
Transient alarm: StateValue flipped back to OK before triage — spike, not sustained; monitor but no immediate action.`,
  },
  {
    source: "crdb-ranges",
    title: "CockroachDB SHOW RANGES — output fields and hot range detection",
    content: `SHOW RANGES FROM TABLE <table_name> returns range metadata. Key columns:
- range_id: internal ID of the range
- start_key / end_key: key boundaries of the range (hex-encoded for non-text keys)
- lease_holder: node ID that holds the range lease (handles all reads/writes for the range)
- replicas: array of node IDs holding replicas (should have replication_factor entries, default 3)
- range_size_mb: approximate size of the range; ranges split automatically at ~512MB
Hot range detection:
SELECT range_id, lease_holder, split_enforced_until
FROM [SHOW RANGES FROM TABLE <t>]
WHERE range_id IN (
  SELECT range_id FROM crdb_internal.cluster_contention_events
  GROUP BY range_id ORDER BY count(*) DESC LIMIT 5
);
Fix: ALTER TABLE <t> SCATTER; — redistributes range leases across nodes.
Root cause prevention: avoid monotonically increasing primary keys (use gen_random_uuid() or ULID).`,
  },
  {
    source: "crdb-contention",
    title: "CockroachDB crdb_internal.cluster_contention_events",
    content: `crdb_internal.cluster_contention_events shows lock contention between transactions. Key columns:
- table_id: OID of the table where contention occurred
- index_id: index involved (0 = primary key)
- num_contention_events: cumulative count of contention events for this key
- cumulative_contention_time: total wall-clock time transactions waited on this key
- key: the specific row key that was contended
Join with information_schema to get table name:
SELECT c.num_contention_events, c.cumulative_contention_time, t.table_name
FROM crdb_internal.cluster_contention_events c
JOIN information_schema.tables t ON c.table_id::TEXT = t.table_schema
ORDER BY c.num_contention_events DESC LIMIT 10;
High contention (> 100 events/min on one key) = hot row or missing index on a write-heavy column.
Resolution: add an index, change the write pattern, or use SPLIT AT VALUES to distribute the key range.`,
  },
  {
    source: "crdb-pg-stat",
    title: "CockroachDB pg_stat_activity — active query monitoring",
    content: `pg_stat_activity in CockroachDB is compatible with PostgreSQL pg_stat_activity. Key columns:
- pid: session ID (use with pg_cancel_backend / pg_terminate_backend / CANCEL QUERY)
- query: current SQL statement text
- state: "active" | "idle" | "idle in transaction" | "idle in transaction (aborted)"
- wait_event_type: "Lock" (contention), "Client" (waiting on app), null (running)
- query_start: timestamp when query started; elapsed = now() - query_start
- application_name: client label (e.g. "pgx", "prisma", "cloud-surgeon")
Find long-running queries (> 30s):
SELECT pid, now() - query_start AS elapsed, state, wait_event_type, left(query, 100)
FROM pg_stat_activity
WHERE query_start < now() - interval '30 seconds' AND state != 'idle'
ORDER BY elapsed DESC;
Cancel (rolls back transaction): SELECT pg_cancel_backend(<pid>);
Terminate (closes connection): SELECT pg_terminate_backend(<pid>);
CockroachDB equivalent: CANCEL QUERY '<query_id>' (use crdb_internal.node_queries for query_id).`,
  },
  {
    source: "crdb-changefeed",
    title: "CockroachDB changefeed monitoring and RESUME JOB",
    content: `SHOW CHANGEFEED JOBS returns job state. Key columns:
- job_id: integer job ID (use with RESUME JOB, PAUSE JOB, CANCEL JOB)
- status: "running" | "paused" | "failed" | "canceled"
- error: last error message if status = "failed" or "paused" due to error
- high_water_timestamp: last successfully emitted event timestamp (lag = now() - high_water_timestamp)
- sink_uri: destination URL (Kafka topic, webhook URL, S3 path)
- topics / tables: tables being watched
Common failure causes:
- Network error to sink: transient; RESUME JOB usually fixes it
- Schema change without ON UPDATE: changefeed pauses on ALTER TABLE (add ON UPDATE ADD COLUMN to the changefeed expression)
- Backfill stall: initial scan takes too long; increase changefeed.backfill.concurrent_scan_requests cluster setting
Resume procedure: RESUME JOB <job_id>; then monitor:
SELECT job_id, status, now() - high_water_timestamp::TIMESTAMPTZ AS lag FROM [SHOW CHANGEFEED JOBS] WHERE job_id = <id>;
Success: status = "running", lag trending toward 0.`,
  },
  {
    source: "crdb-jobs",
    title: "CockroachDB crdb_internal.node_statement_statistics — slow query analysis",
    content: `crdb_internal.node_statement_statistics aggregates per-statement performance. Key columns:
- key: statement fingerprint (normalized SQL with literals replaced by $N)
- count: number of executions
- total_service_lat: cumulative execution time (seconds); avg = total_service_lat / count
- rows_avg: average rows returned / affected
- full_scan: boolean — true if the query does a full table scan (missing index)
- implicit_txn: true for auto-commit statements
Find top slow statements with full scans:
SELECT key, count, total_service_lat / count AS avg_lat_s, full_scan
FROM crdb_internal.node_statement_statistics
WHERE full_scan = true
ORDER BY total_service_lat DESC LIMIT 10;
Fix full_scan = true: CREATE INDEX CONCURRENTLY ON <table> (<column>);
Verify fix: EXPLAIN SELECT ... — look for "full scan" tag disappearing.
Rebuild stats after index: ANALYZE <table>;`,
  },
  {
    source: "crdb-replication",
    title: "CockroachDB under-replicated ranges and node recovery",
    content: `Under-replicated ranges: a range has fewer than replication_factor live replicas (default RF=3).
Detection:
SELECT * FROM crdb_internal.ranges
WHERE array_length(replicas, 1) < 3 OR lease_holder = 0;
Also check cluster metric: under_replicated_ranges (should be 0 in healthy cluster).
Causes:
1. Node down: check node liveness: SELECT node_id, is_live, draining FROM crdb_internal.gossip_liveness;
2. Disk full on a node: check crdb_internal.kv_store_status for store capacity
3. Network partition: isolated node stops heartbeating gossip
Recovery is automatic when the failed node rejoins or a new node is added.
Manual trigger range rebalance: ALTER TABLE <t> CONFIGURE ZONE USING num_replicas = 3;
Monitor recovery: watch SELECT count(*) FROM crdb_internal.ranges WHERE array_length(replicas,1) < 3;
Expected: under_replicated_ranges reaches 0 within 5 minutes of node restore.`,
  },
  {
    source: "aws-rds",
    title: "RDS autovacuum — detection and tuning",
    content: `PostgreSQL autovacuum on RDS runs automatically to reclaim dead tuples. Signs of pressure:
- High WriteIOPS without corresponding application writes
- n_dead_tup accumulating in pg_stat_user_tables
- autovacuum_count and autoanalyze_count incrementing rapidly
Diagnosis query:
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze,
  autovacuum_count, autoanalyze_count
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
Bloat ratio: n_dead_tup / n_live_tup > 0.2 (20%) on a large table = autovacuum cannot keep up.
Emergency manual VACUUM: VACUUM ANALYZE <table>; (blocks writers briefly if table is locked)
Tuning: increase autovacuum_vacuum_scale_factor (default 0.2 = 20% of table) for large tables:
ALTER TABLE <t> SET (autovacuum_vacuum_scale_factor = 0.01);
Note: VACUUM FULL reclaims disk space but requires exclusive lock — use only in maintenance window.`,
  },
  {
    source: "aws-ecs",
    title: "ECS ALB health check configuration and HealthyHostCount",
    content: `ECS services registered with an ALB target group use health checks to determine task readiness.
Key ALB Target Group metrics (namespace AWS/ApplicationELB):
- HealthyHostCount: number of targets passing health checks (must reach desiredCount for stable deployment)
- UnHealthyHostCount: targets failing health checks (should be 0 at steady state)
- TargetResponseTime: latency in seconds from ALB to target
- HTTPCode_Target_5XX_Count: 5xx errors from ECS tasks (NOT the ALB itself)
Health check configuration (in ECS task definition or target group):
- Protocol: HTTP/HTTPS, path: /health or /healthz (default /), port: traffic port
- HealthyThresholdCount: consecutive successes before marking healthy (default 5)
- UnhealthyThresholdCount: consecutive failures before marking unhealthy (default 2)
- Interval: seconds between checks (default 30s); HealthCheckTimeoutSeconds (default 5s)
Troubleshooting UnHealthyHostCount > 0:
1. Check task logs for startup errors (application not binding to the correct port)
2. Verify the health check path returns 200 OK (not 301 redirect)
3. Verify security group allows ALB to reach task on the health check port`,
  },
];

// ── Table setup ───────────────────────────────────────────────────────────

export async function ensureDocChunksTable(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(CREATE_DOC_CHUNKS_TABLE);
    // Vector index creation may fail if extension not ready — non-fatal
    await client.query(CREATE_DOC_CHUNKS_VECTOR_INDEX).catch(() => {});
  } finally {
    client.release();
  }
}

// ── Seeding ────────────────────────────────────────────────────────────────

export async function seedDocChunks(): Promise<void> {
  await ensureDocChunksTable();

  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT COUNT(*) AS n FROM doc_chunks");
    const existing = parseInt(rows[0].n, 10);
    if (existing >= DOC_CHUNKS.length) {
      logger.debug({ existing, total: DOC_CHUNKS.length }, "[DocRAG] doc_chunks already seeded");
      return;
    }

    logger.info({ total: DOC_CHUNKS.length, existing }, "[DocRAG] Seeding doc_chunks...");
    let seeded = 0;
    for (const chunk of DOC_CHUNKS) {
      // Skip if already seeded (by title — idempotent)
      const { rows: exists } = await client.query(
        "SELECT 1 FROM doc_chunks WHERE title = $1 LIMIT 1",
        [chunk.title],
      );
      if (exists.length > 0) continue;

      const { embedding } = await generateEmbedding(`${chunk.title}\n\n${chunk.content}`);
      const vec = `[${embedding.join(",")}]`;
      await client.query(
        "INSERT INTO doc_chunks (source, title, content, embedding) VALUES ($1, $2, $3, $4::vector)",
        [chunk.source, chunk.title, chunk.content, vec],
      );
      seeded++;
    }
    logger.info({ seeded }, "[DocRAG] doc_chunks seeding complete");
  } finally {
    client.release();
  }
}

// ── Tier 1: Vector search ─────────────────────────────────────────────────

export interface DocChunk {
  chunkId: string;
  source: string;
  title: string;
  content: string;
  distance: number;
}

export async function findRelevantDocChunks(
  query: string,
  limit = 2,
): Promise<DocChunk[]> {
  try {
    const { embedding } = await generateEmbedding(query);
    const vec = `[${embedding.join(",")}]`;
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT chunk_id, source, title, content,
                embedding <=> $1::vector AS distance
         FROM doc_chunks
         ORDER BY distance ASC
         LIMIT $2`,
        [vec, limit],
      );
      return rows.map((r) => ({
        chunkId: r.chunk_id,
        source: r.source,
        title: r.title,
        content: r.content,
        distance: parseFloat(r.distance),
      }));
    } finally {
      client.release();
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[DocRAG] findRelevantDocChunks failed");
    return [];
  }
}

// ── Tier 2: Live web fetch fallback ───────────────────────────────────────
//
// Curated keyword→URL map for the most common lookup topics.
// Fetches the page, strips HTML tags, returns the first ~1500 chars of body text.

const DOC_URL_MAP: Array<{ keywords: RegExp[]; url: string; label: string }> = [
  {
    keywords: [/describe.?services?/i, /ecs.*task/i, /runnin.*count/i, /stopped.*reason/i],
    url: "https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeServices.html",
    label: "AWS ECS DescribeServices API",
  },
  {
    keywords: [/max.?connections/i, /database.?connections/i, /pg_stat_activity/i, /connection.?pool/i],
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html",
    label: "AWS RDS Limits and Connection Limits",
  },
  {
    keywords: [/lambda.*throttl/i, /concurrent.?executions?/i, /iterator.*age/i],
    url: "https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html",
    label: "AWS Lambda Concurrency",
  },
  {
    keywords: [/changefeed/i, /high.?water/i, /cdc.*job/i],
    url: "https://www.cockroachlabs.com/docs/stable/monitor-and-debug-changefeeds.html",
    label: "CockroachDB Changefeed Monitoring",
  },
  {
    keywords: [/show.*ranges?/i, /hot.*range/i, /lease.*holder/i, /contention.*event/i],
    url: "https://www.cockroachlabs.com/docs/stable/show-ranges.html",
    label: "CockroachDB SHOW RANGES",
  },
  {
    keywords: [/under.?replicated/i, /replication.*lag/i, /range.*unavailable/i],
    url: "https://www.cockroachlabs.com/docs/stable/ui-replication-dashboard.html",
    label: "CockroachDB Replication Dashboard",
  },
  {
    keywords: [/access.?denied/i, /iam.*key/i, /credential.*rotation/i, /sts.*token/i],
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_access-denied.html",
    label: "AWS IAM AccessDenied Troubleshooting",
  },
  {
    keywords: [/autovacuum/i, /dead.?tuple/i, /bloat/i, /vacuum/i],
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Autovacuum.html",
    label: "AWS RDS Autovacuum",
  },
];

const DOC_CONFIDENCE_THRESHOLD = 0.40; // cosine distance; lower = more similar

async function fetchDocUrl(url: string, label: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "cloud-surgeon-docbot/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Strip tags, collapse whitespace, take first 1500 chars of meaningful text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);
    return `[${label}]\n${text}`;
  } catch {
    return null;
  }
}

function pickDocUrl(query: string): { url: string; label: string } | null {
  for (const entry of DOC_URL_MAP) {
    if (entry.keywords.some((re) => re.test(query))) {
      return { url: entry.url, label: entry.label };
    }
  }
  return null;
}

// ── Public: combined search (Tier 1 + Tier 2) ─────────────────────────────

/**
 * Used by the Nova Lite search_docs tool call handler.
 * Returns formatted documentation text relevant to the query.
 */
export async function searchDocs(query: string): Promise<string> {
  // Tier 1: vector search
  const chunks = await findRelevantDocChunks(query, 2);
  const goodChunks = chunks.filter((c) => c.distance < DOC_CONFIDENCE_THRESHOLD);

  if (goodChunks.length > 0) {
    logger.debug(
      { query: query.slice(0, 60), hits: goodChunks.length, bestDistance: goodChunks[0].distance },
      "[DocRAG] Vector hit",
    );
    return goodChunks
      .map((c) => `[${c.title}]\n${c.content}`)
      .join("\n\n---\n\n");
  }

  // Tier 2: live web fetch
  const target = pickDocUrl(query);
  if (target) {
    logger.debug({ query: query.slice(0, 60), url: target.url }, "[DocRAG] Web fetch fallback");
    const text = await fetchDocUrl(target.url, target.label);
    if (text) return text;
  }

  // No result — return best vector hit anyway (even if confidence is low)
  if (chunks.length > 0) {
    return `[${chunks[0]!.title}] (low confidence — distance: ${chunks[0]!.distance.toFixed(2)})\n${chunks[0]!.content}`;
  }

  return "No relevant documentation found for this query.";
}

// ── Format doc chunks for injection into system prompt ────────────────────

export function formatDocChunksForPrompt(chunks: DocChunk[]): string {
  if (chunks.length === 0) return "";
  const relevant = chunks.filter((c) => c.distance < DOC_CONFIDENCE_THRESHOLD);
  if (relevant.length === 0) return "";
  return (
    "\n\nRelevant documentation (retrieved from official AWS/CockroachDB docs):\n" +
    relevant.map((c) => `### ${c.title}\n${c.content}`).join("\n\n")
  );
}

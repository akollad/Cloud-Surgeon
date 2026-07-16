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
  // ── Cloud-Surgeon strategy skills ────────────────────────────────────────
  // Each skill is embedded so the agent can retrieve the right strategy
  // by similarity to the incoming alert text, instead of relying only on
  // hardcoded keyword matching. Source: "cloud-surgeon-skill".
  {
    source: "cloud-surgeon-skill",
    title: "Skill: ecs_service_restart — ECS task crash, deployment failure, 5xx spike",
    content: `Strategy: ecs_service_restart
Alert signals: ECS tasks crashing, 5xx error spike, container exit, deployment stuck, unhealthy tasks, ALB health check failing, high HTTP 5XX count.
When to choose: any alert involving ECS task lifecycle or deployment stability.
MCP tool: aws_repair_service(serviceName, "describe_and_remediate")
Key diagnostic fields: runningCount, pendingCount, desiredCount, deploymentStatus (COMPLETED/FAILED/IN_PROGRESS), events[].message, stoppedReason, containers[].exitCode.
Repair: force new ECS deployment — rolling restart replacing tasks one at a time.
Success: runningCount == desiredCount, pendingCount == 0, deploymentStatus = "COMPLETED", HealthyHostCount == desiredCount.
Common root causes: bad Docker image tag (CannotPullContainerError), OOM kill (exit code 137), missing dependency at startup, failed ELB health check path.
Blast radius: low — rolling restart keeps minimum healthy count throughout.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: rds_cpu_throttle — RDS high CPU, slow queries, autovacuum storm",
    content: `Strategy: rds_cpu_throttle
Alert signals: RDS CPUUtilization > 80%, high ReadLatency, autovacuum storm, slow query count rising, WriteIOPS spike without load increase.
When to choose: database CPU alarm; do NOT use if DatabaseConnections is also high (use db_connection_pool_reset instead).
MCP tool: aws_repair_service with RDS instance identifier.
Key CloudWatch metrics: CPUUtilization, DatabaseConnections, ReadIOPS, WriteIOPS, FreeableMemory, ReadLatency.
Autovacuum signal: high WriteIOPS with moderate CPU, autovacuum_count rising in pg_stat_user_tables.
Repair: add per-query throttle via Parameter Group to reduce CPU pressure.
Success: CPUUtilization drops below 70% within 90 s, ReadLatency normalises below 20 ms.
Common root causes: unindexed query causing full table scan, autovacuum reclaiming dead tuples, connection pressure.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: db_connection_pool_reset — connection pool exhaustion, too many clients",
    content: `Strategy: db_connection_pool_reset
Alert signals: "too many clients", DatabaseConnections at or near max_connections, connection pool exhausted, application connection timeout.
When to choose: DatabaseConnections >= 80% of max_connections limit (100 for db.t3.micro, 200 for db.t3.medium).
MCP tool: crdb_cluster_health or aws_repair_service for connection state.
Key fields: DatabaseConnections (current), max_connections (limit), idle_count, wait_event_type (Lock=contention, Client=app waiting).
Repair: terminate idle connections older than 30 s, flush the pool, trigger application reconnect.
Success: DatabaseConnections drops below 80% of max_connections within 60 s, CPUUtilization returns to baseline.
Root cause: connection leak — application not releasing pool connections (missing pool.release(), context manager not closed, long idle transactions).`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: lambda_concurrency_scale — Lambda throttling, iterator age rising, 429 errors",
    content: `Strategy: lambda_concurrency_scale
Alert signals: Lambda Throttles metric > 0, TooManyRequestsException (429), IteratorAge rising for Kinesis/SQS, function invocations dropping.
When to choose: any Lambda throttling alert; confirms when ConcurrentExecutions hits reserved or account limit (default 1000/region).
MCP tool: aws_repair_service with Lambda function name.
Key CloudWatch metrics: ConcurrentExecutions, Throttles, Duration, Errors, IteratorAge (stream triggers).
Repair: scale reserved concurrency up; effect takes < 10 seconds, no cold starts for existing warm instances.
Success: Throttles metric drops to 0, IteratorAge trend decreasing, Errors return to pre-incident baseline.
Watch for cascade: Lambda scaling may increase RDS DatabaseConnections — always monitor together.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: jvm_heap_restart — OOM kill, JVM heap exhaustion, exit code 137",
    content: `Strategy: jvm_heap_restart
Alert signals: ECS task exit code 137 (OOM SIGKILL), JVM OutOfMemoryError in logs, MemoryUtilization near 100%, Full GC frequency spiking.
When to choose: task exits with stoppedReason containing "OutOfMemoryError" or exitCode=137.
MCP tool: aws_repair_service targeting the ECS service.
Key signals: MemoryUtilization (ECS task level), JVM HeapMemoryUsage (via CloudWatch agent/JMX), GcPauseMilliseconds, stoppedReason.
Repair: restart the ECS task; JVM reallocates heap from Xms on startup; Full GC normalises within 2–3 minutes.
Success: MemoryUtilization below 80% for 2 consecutive minutes, GC pause < 500 ms, no stoppedReason in new task.
Escalate if: MemoryUtilization immediately spikes again — task definition Xmx is undersized, require task definition update.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: iam_credential_rotation — AccessDenied, expired credentials, STS token expired",
    content: `Strategy: iam_credential_rotation
Alert signals: AccessDenied errors in CloudTrail, credential expiry (> 1 year old keys), STS session token expired (max 12 h), sudden permission failure.
When to choose: IAM AccessDenied in CloudTrail, NoCredentialProviders error, sudden auth failure after working previously.
MCP tool: aws_repair_service with IAM action context.
Key CloudTrail fields: errorCode (AccessDenied vs NoCredentialProviders), eventName (the failing API call), userIdentity.arn, requestParameters.
Rotation steps: create new key → update Secrets Manager → force ECS deployment → verify CloudTrail errors stop → delete old key after 24 h.
Success: AccessDenied errors in CloudTrail stop within 60 s of new credentials propagating, applications reconnect.
Blast radius: medium — service unavailable during credential gap; keep old key active until new one confirmed working.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: network_route_failover — cross-region latency spike, BGP instability, Route53 failover",
    content: `Strategy: network_route_failover
Alert signals: cross-region latency > 100 ms, BGP route instability, primary region ALB HealthyHostCount dropping, TargetResponseTime spike.
When to choose: multi-region deployments with Route53 health-check failover; single-region issues use ecs_service_restart instead.
MCP tool: aws_repair_service targeting the ALB/Route53 resource.
Key CloudWatch metrics (BOTH regions): TargetResponseTime, HTTPCode_Target_5XX_Count, HealthyHostCount.
Repair: update Route53 weighted routing to shift traffic to secondary region; DNS propagation takes up to 60 s (TTL).
Success: TargetResponseTime on secondary matches pre-incident baseline, 0 failed ALB health checks.
Warning: 60 s DNS propagation blast window — old traffic continues on primary during TTL.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: external_dependency_circuit_break — upstream 5xx, circuit open, third-party timeout",
    content: `Strategy: external_dependency_circuit_break
Alert signals: external API calls failing at > 50% error rate, circuit breaker open state, upstream 5xx errors, cascading timeouts.
When to choose: errors are sourced from an external dependency (payment gateway, notification service, upstream API) not from internal infra.
Circuit breaker states: CLOSED (normal), OPEN (requests blocked), HALF_OPEN (one probe allowed).
Opens when: error rate > threshold (typically 50%) for N consecutive requests (5–10).
Key signals: ErrorRate, FailedRequests count, CircuitState in health endpoint, upstream 5xx rate.
Half-open probe: one request allowed through — if succeeds, circuit closes; if fails, stays OPEN.
Success: CircuitState transitions to CLOSED, ErrorRate below threshold for 60 s, upstream 5xx back to baseline.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: disk_cleanup — ECS disk full, container overlay FS exhaustion, high inode count",
    content: `Strategy: disk_cleanup
Alert signals: disk usage > 85%, EcsTaskDiskUsage alarm, container logs filling disk, EBS volume full, write I/O errors.
When to choose: ECS container disk full; confirm with EBSByteBalance% CloudWatch metric.
Safe cleanup targets: /tmp (always safe), Docker logs older than 24 h, stopped container layers, orphaned volumes.
Key metrics: EBSByteBalance% (credit-based instances), disk usage %, inode usage % (high count = many small files).
WARNING: deleted files are unrecoverable without EBS snapshot — verify snapshot exists before cleanup.
Success: disk usage drops below 75%, I/O wait (ioWait CloudWatch metric) normalises below 5%.
Prevent recurrence: add log rotation (logrotate), limit Docker log size via max-size option in log driver config.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: cloudwatch_alarm_triage — unknown alarm, read-only diagnosis, route to correct strategy",
    content: `Strategy: cloudwatch_alarm_triage
Alert signals: generic CloudWatch alarm with unknown root cause; alarm state not mapped to a specific strategy.
When to choose: alarm text does not match ECS/RDS/Lambda/IAM patterns; treat as exploratory — read-only, no infra changes.
Key CloudWatch fields: StateValue (OK/ALARM/INSUFFICIENT_DATA), StateReason (human-readable explanation), MetricName, Namespace, Dimensions, Threshold.
INSUFFICIENT_DATA: resource may be stopped or deleted — no data points in evaluation period.
Transient alarm: StateValue flipped back to OK before triage — spike, not sustained; monitor only.
Output: identifies root metric and threshold, routes to the correct named strategy for repair.
Success: root cause identified with enough confidence to pick a specific repair strategy.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: crdb_hotspot_resolution — CockroachDB hot range, transaction contention, write skew",
    content: `Strategy: crdb_hotspot_resolution
Alert signals: CockroachDB high contention events, hot range alert, transaction retry errors, high write latency on a single table.
When to choose: crdb_internal.cluster_contention_events shows > 95% of reads/writes hitting one range.
MCP tool: crdb_diagnose_hotspots (detects hot ranges), crdb_skill_repair(strategy="crdb_hotspot_resolution").
Root causes: auto-incremented primary keys (all inserts hit the same range end), hot secondary index, monotonically increasing timestamps.
Diagnostic SQL: SELECT range_id, lease_holder FROM [SHOW RANGES FROM TABLE <t>].
Repair: ALTER TABLE ... SCATTER (redistributes leases); DDL change to UUID/ULID primary key for long-term fix.
Success: contention events drop to 0 in crdb_internal.cluster_contention_events within 2 minutes.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: crdb_index_optimization — CockroachDB full scan, slow queries, missing index",
    content: `Strategy: crdb_index_optimization
Alert signals: CockroachDB high read latency, EXPLAIN shows "full scan", crdb_internal.index_recommendations has pending items, query optimizer warnings.
When to choose: slow CockroachDB queries caused by missing or redundant indexes; confirmed by crdb_internal.node_statement_statistics.
MCP tool: crdb_index_advisor (surfaces missing/redundant indexes with DDL), crdb_skill_repair(strategy="crdb_index_optimization").
Key fields: full_scan (bool), total_elapsed_time, recommended_ddl (ready-to-execute CREATE INDEX statement).
Repair: CREATE INDEX CONCURRENTLY ON <table> (<column>); — non-blocking, no table lock during backfill.
Success: full_scan = false in EXPLAIN, query elapsed time drops > 50%, index_recommendations cleared.
Verify: ANALYZE <table>; after index creation to update statistics.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: crdb_slow_query_termination — CockroachDB long-running query, lock contention, connection saturation",
    content: `Strategy: crdb_slow_query_termination
Alert signals: CockroachDB long-running transactions blocking other queries, lock wait timeout, connection pool saturation caused by slow queries.
When to choose: pg_stat_activity shows queries running > 30 s with wait_event_type = Lock.
MCP tool: crdb_list_slow_queries (list candidates), crdb_cancel_query (cancel with dryRun=true first), crdb_skill_repair(strategy="crdb_slow_query_termination").
Key fields: query_id, elapsed_time, wait_event_type (Lock=contention, Client=app waiting), application_name.
Repair: CANCEL QUERY '<query_id>' — rolls back the transaction immediately, low blast radius.
Success: slow queries gone from pg_stat_activity, DatabaseConnections normalises, transaction throughput recovers.
Safe procedure: always dry-run first (dryRun=true) to list candidates before cancelling.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: crdb_replication_recovery — CockroachDB under-replicated ranges, node down, disk full",
    content: `Strategy: crdb_replication_recovery
Alert signals: under_replicated_ranges metric > 0, CockroachDB node down alert, replication lag, cluster node liveness failure.
When to choose: crdb_internal.ranges shows array_length(replicas, 1) < 3 (below replication factor).
MCP tool: crdb_cluster_health (cluster state), crdb_query on crdb_internal.ranges_no_leases, crdb_skill_repair(strategy="crdb_replication_recovery").
Causes: node down (check crdb_internal.gossip_liveness), disk full on a node (crdb_internal.kv_store_status), network partition.
Recovery is automatic when node rejoins or new node is added; manual trigger: ALTER TABLE <t> CONFIGURE ZONE USING num_replicas = 3.
Success: under_replicated_ranges = 0, all ranges show 3 live replicas — expected within 5 min of node restore.`,
  },
  {
    source: "cloud-surgeon-skill",
    title: "Skill: crdb_changefeed_restart — CockroachDB CDC paused, changefeed failed, webhook sink error",
    content: `Strategy: crdb_changefeed_restart
Alert signals: CockroachDB changefeed paused or failed, CDC lag rising, downstream consumers not receiving events, high_water_timestamp not advancing.
When to choose: SHOW CHANGEFEED JOBS shows status = "paused" or "failed".
MCP tool: crdb_job_status(jobType="changefeed"), crdb_query for RESUME JOB, crdb_skill_repair(strategy="crdb_changefeed_restart").
Common causes: network error to sink (transient — RESUME JOB usually fixes), schema change without ON UPDATE ADD COLUMN, backfill stall.
Key fields: job_id, status, error (last error), high_water_timestamp (lag = now() - high_water_timestamp).
Repair: RESUME JOB <job_id>; monitor lag_seconds — should trend toward 0.
Success: status = "running", lag_seconds approaching 0, downstream consumers receiving events again.`,
  },

  // ── MCP tool usage guides ─────────────────────────────────────────────────
  // Help the agent know which MCP tool to call for each diagnostic need.
  {
    source: "cloud-surgeon-mcp",
    title: "MCP tool: crdb_diagnose_hotspots — when and how to detect CockroachDB hot ranges",
    content: `Tool: crdb_diagnose_hotspots (CockroachDB Agent Skill — Performance)
Call when: alert involves high CockroachDB write/read latency, contention events, transaction retries.
What it returns: top-N tables/indexes with contention_events count, cumulative_contention_time, hottest_key, largest ranges by size_mb.
Input: topN (default 10), database (default defaultdb).
Interpretation: high contention_events on one table = hot range; cumulative_contention_time > 1s = significant impact.
Follow-up actions: if hot range found → ALTER TABLE ... SCATTER or DDL key change; check crdb_index_advisor for related index opportunities.
Skill ID: crdb/performance/diagnose-hotspots`,
  },
  {
    source: "cloud-surgeon-mcp",
    title: "MCP tool: crdb_index_advisor — surface missing and redundant CockroachDB indexes",
    content: `Tool: crdb_index_advisor (CockroachDB Agent Skill — Schema Design)
Call when: slow CockroachDB queries, full table scans in EXPLAIN output, high read amplification.
What it returns: CockroachDB optimizer recommendations — type (index_replacement or drop_unused_index), object_name, index_name, recommended_ddl (CREATE/DROP INDEX statement ready to execute).
Input: database (default defaultdb), type filter (index_replacement / drop_unused_index / all).
How to apply: execute recommended_ddl in a transaction during low-traffic hours; DROP INDEX requires CONCURRENTLY in CockroachDB 23.1+.
Verify after: ANALYZE <table>; + EXPLAIN to confirm full scan eliminated.
Skill ID: crdb/schema/index-advisor`,
  },
  {
    source: "cloud-surgeon-mcp",
    title: "MCP tool: crdb_cancel_query — safely cancel long-running CockroachDB queries",
    content: `Tool: crdb_cancel_query (CockroachDB Agent Skill — Operations)
Call when: long-running CockroachDB queries blocking writes, connection saturation from idle-in-transaction sessions.
What it returns: list of queries running longer than thresholdSeconds, their query_id, running_seconds, query_preview, username.
Input: thresholdSeconds (default 30), dryRun (default true — safe), database.
Safe procedure: always call with dryRun=true first to review candidates; set dryRun=false to cancel top-3.
What cancel does: crdb_internal.cancel_query() rolls back the transaction — no structural changes, low blast radius.
Only targets SELECT/UPDATE/DELETE — never DDL (safe to run autonomously).
Skill ID: crdb/operations/cancel-query`,
  },
  {
    source: "cloud-surgeon-mcp",
    title: "MCP tool: crdb_job_status — CockroachDB changefeed, backup, and schema change health",
    content: `Tool: crdb_job_status (CockroachDB Agent Skill — Observability)
Call when: CDC stall, backup failure, schema change timeout, changefeed lag alert.
What it returns: list of jobs with job_id, job_type, status (paused/failed/running), description, last_error, fraction_completed.
Input: jobType (changefeed/backup/schema_change/all), statusFilter (paused/failed/running/all).
Follow-up for paused changefeed: RESUME JOB <job_id>; then monitor lag.
Follow-up for failed backup: re-run BACKUP INTO statement.
Skill ID: crdb/observability/job-status`,
  },
  {
    source: "cloud-surgeon-mcp",
    title: "MCP tool: execute_ccloud_command — CockroachDB Cloud cluster management and inspection",
    content: `Tool: execute_ccloud_command
Call when: need cluster-level information (version, state, backups, SQL users, connection hostname).
What it returns: cluster detail from CockroachDB Cloud API; cliMode field = "ccloud_binary" (ECS prod) or "rest" (dev fallback).
Supported actions: cluster:status (default), cluster:list, cluster:sql-users, cluster:backups, cluster:version, cluster:sql-dns.
Each response includes ccloudEquivalent — the exact CLI command that produced the data.
Requires: COCKROACH_CLOUD_API_KEY and COCKROACH_CLOUD_CLUSTER_ID environment variables.`,
  },
  {
    source: "cloud-surgeon-mcp",
    title: "MCP tool: aws_repair_service — ECS force-deploy, RDS connection reset, Lambda concurrency scale",
    content: `Tool: aws_repair_service
Call when: AWS infrastructure repair is needed — ECS task crash, RDS connection exhaustion, Lambda throttling.
Service routing (inferred from serviceName + action string):
- Contains "lambda" or "function" → Lambda concurrency scale-up
- Contains "rds", "db", "postgres" and RDS_INSTANCE_IDENTIFIER is set → RDS connection reset
- Contains "rds"/"database" but no RDS (CockroachDB deployment) → ECS health check instead
- Default: ECS force new deployment
Input: serviceName (e.g. "cloud-surgeon/api" for ECS, DB instance ID for RDS, function name for Lambda), action ("describe_and_remediate").
Falls back to SIMULATED mode when AWS_ACCESS_KEY_ID is absent — always labelled in output.`,
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

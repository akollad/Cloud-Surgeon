/**
 * Vector memory seed
 *
 * Inserts synthetic incidents (one per known scenario) into
 * `incident_vectors` so that the Layer 1 RAG has a knowledge base
 * from the very first startup. Without this seed, all new incidents are
 * routed in EXPLORATORY mode until a first real incident is resolved and indexed.
 *
 * Each seed entry has `outcome_success = true` and reflects the nominal
 * strategy for that incident type. Seed entries have no source incident_id
 * (they do not originate from a concrete resolved incident).
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { generateEmbedding } from "./embeddings";

const SEED_INCIDENTS: Array<{ text: string; strategy: string }> = [
  {
    text: "ECS service 'checkout' unhealthy: 5xx spike on /pay endpoint, latency p99 > 4s",
    strategy: "ecs_service_restart",
  },
  {
    text: "RDS primary instance 'orders-db' CPU utilization at 98% for 10 minutes",
    strategy: "rds_cpu_throttle",
  },
  {
    text: "Lambda function 'order-processor' throttled: ConcurrentExecutions limit reached",
    strategy: "lambda_concurrency_scale",
  },
  {
    text: "EC2 instance 'worker-03' disk usage at 95%, risk of service crash",
    strategy: "disk_cleanup",
  },
  {
    text: "JVM heap exhaustion on 'recommendation-service' pod: GC overhead limit exceeded, OOMKiller triggered",
    strategy: "jvm_heap_restart",
  },
  {
    text: "RDS 'catalog-db' max_connections reached (500/500): new connections refused, pg_stat_activity shows idle-in-transaction sessions",
    strategy: "db_connection_pool_reset",
  },
  {
    text: "API Gateway p99 latency degraded: us-east-1 to eu-west-1 cross-region calls averaging 2800ms, BGP route flap",
    strategy: "network_route_failover",
  },
  {
    text: "ECS task 'data-export' failing: AccessDeniedException on s3:PutObject — IAM role credential rotation missed, token expired",
    strategy: "iam_credential_rotation",
  },
  {
    text: "Payment gateway degraded: Stripe API returning 503, checkout conversion rate dropped from 94% to 12%",
    strategy: "external_dependency_circuit_break",
  },
];

/** Process-level flag: avoids re-checking the DB on every startup. */
let seeded = false;

/**
 * Seeds the vector memory with synthetic incidents.
 *
 * @param force - When true, deletes all existing seed entries (incident_id IS NULL)
 *   and re-inserts them. Use after changing the embedding provider so that stored
 *   vectors and query vectors live in the same embedding space.
 *   When false (default), skips if seeds already exist (idempotent).
 */
export async function seedVectorMemory(
  force = false,
): Promise<{ seeded: boolean; count: number; provider?: string }> {
  if (!force && seeded) return { seeded: false, count: 0 };

  if (force) {
    // Purge stale seeds so they are recreated in the current embedding space
    await db.execute(sql`DELETE FROM incident_vectors WHERE incident_id IS NULL`);
    seeded = false;
  } else {
    // Count non-default seed entries (= real seed entries)
    const countResult = await db.execute<{ n: string }>(sql`
      SELECT COUNT(*) AS n
      FROM incident_vectors
      WHERE incident_id IS NULL
        AND strategy_name != 'default_repair'
    `);
    const existingSeeds = Number(countResult.rows[0]?.n ?? 0);
    if (existingSeeds >= SEED_INCIDENTS.length) {
      seeded = true;
      return { seeded: false, count: existingSeeds };
    }
  }

  // Insert via direct SQL to avoid Drizzle issues with nullable UUID columns.
  let provider = "unknown";
  for (const s of SEED_INCIDENTS) {
    const result = await generateEmbedding(s.text);
    provider = result.provider;
    const embeddingLiteral = `[${result.embedding.join(",")}]`;
    await db.execute(sql`
      INSERT INTO incident_vectors
        (error_message_text, embedding, strategy_name, outcome_success)
      VALUES
        (${s.text}, ${embeddingLiteral}::vector, ${s.strategy}, TRUE)
      ON CONFLICT DO NOTHING
    `);
  }

  seeded = true;
  return { seeded: true, count: SEED_INCIDENTS.length, provider };
}

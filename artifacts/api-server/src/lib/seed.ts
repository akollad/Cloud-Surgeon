/**
 * Seed de la mémoire vectorielle
 *
 * Insère des incidents synthétiques (un par scénario connu) dans
 * `incident_vectors` pour que le RAG de la Couche 1 ait une base de
 * connaissance dès le premier démarrage. Sans ce seed, tous les nouveaux
 * incidents sont routés en mode EXPLORATORY jusqu'à ce qu'un premier
 * incident réel soit résolu et indexé.
 *
 * Chaque entrée seed a `outcome_success = true` et reflète la stratégie
 * nominale pour ce type d'incident. Les entrées seed n'ont pas d'incident_id
 * source (elles ne proviennent pas d'un incident concret résolu).
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

/** Marqueur process-level : évite de re-vérifier la DB à chaque démarrage. */
let seeded = false;

/**
 * Vérifie si la mémoire vectorielle contient déjà des entrées seed (identifiées
 * par strategy_name != 'default_repair' et incident_id IS NULL), et si non,
 * insère les incidents synthétiques via SQL direct.
 * Appeler au démarrage du serveur — idempotent.
 */
export async function seedVectorMemory(): Promise<{ seeded: boolean; count: number }> {
  if (seeded) return { seeded: false, count: 0 };

  // Compter les entrées seed non-default (= vraies entrées de seed S2)
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

  // Insérer via SQL direct pour éviter tout problème avec les types Drizzle
  // sur les colonnes nullable UUID (incident_id).
  for (const s of SEED_INCIDENTS) {
    const embedding = await generateEmbedding(s.text);
    const embeddingLiteral = `[${embedding.join(",")}]`;
    await db.execute(sql`
      INSERT INTO incident_vectors
        (error_message_text, embedding, strategy_name, outcome_success)
      VALUES
        (${s.text}, ${embeddingLiteral}::vector, ${s.strategy}, TRUE)
      ON CONFLICT DO NOTHING
    `);
  }

  seeded = true;
  return { seeded: true, count: SEED_INCIDENTS.length };
}

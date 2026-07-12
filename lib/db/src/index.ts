import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// This database acts as CockroachDB Serverless for the Cloud-Surgeon agent
// (see cloud-surgeon-agent/README.md): it is a real CockroachDB cluster,
// not a standard Postgres instance.
if (!process.env.COCKROACHDB_URL) {
  throw new Error(
    "COCKROACHDB_URL must be set. Did you forget to provision the CockroachDB Serverless cluster?",
  );
}

export const pool = new Pool({
  connectionString: process.env.COCKROACHDB_URL,
  // Tuned for production: support concurrent agent loops without exhausting
  // CockroachDB Serverless connection limits.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Log pool errors rather than crashing the process — CockroachDB Serverless
// can briefly drop connections during scale events; the pool recovers on its own.
pool.on("error", (err) => {
  console.error("[DB_POOL] Unexpected error on idle client:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";

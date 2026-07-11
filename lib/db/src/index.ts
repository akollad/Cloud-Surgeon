import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Cette base de données joue le rôle de CockroachDB Serverless pour l'agent
// Cloud-Surgeon (voir cloud-surgeon-agent/README.md) : c'est un cluster
// CockroachDB réel, pas un Postgres classique.
if (!process.env.COCKROACHDB_URL) {
  throw new Error(
    "COCKROACHDB_URL must be set. Did you forget to provision the CockroachDB Serverless cluster?",
  );
}

export const pool = new Pool({ connectionString: process.env.COCKROACHDB_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";

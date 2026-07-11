import {
  customType,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// pgvector column type. CockroachDB has a native VECTOR type with the same
// wire format; this dev-environment Postgres uses the pgvector extension
// (`CREATE EXTENSION vector`) to emulate it so the exact same SQL
// (`<=>` cosine distance operator) works in both places.
const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .filter((v) => v.length > 0)
      .map(Number);
  },
});

// Cœur de la résilience : une ligne par incident unique (déduplication par
// alertFingerprint). contextJson contient l'historique complet des tours de
// l'agent afin qu'il puisse reprendre exactement où il s'est arrêté.
export const incidentStateTable = pgTable("incident_state", {
  incidentId: uuid("incident_id").primaryKey().defaultRandom(),
  alertFingerprint: varchar("alert_fingerprint", { length: 255 })
    .notNull()
    .unique(),
  status: varchar("status", { length: 50 }).notNull().default("TRIGGERED"),
  currentStep: varchar("current_step", { length: 100 }),
  contextJson: jsonb("context_json").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertIncidentStateSchema = createInsertSchema(
  incidentStateTable,
).omit({ incidentId: true, updatedAt: true });
export type InsertIncidentState = z.infer<typeof insertIncidentStateSchema>;
export type IncidentState = typeof incidentStateTable.$inferSelect;

// Base de connaissance RAG : messages d'erreur déjà résolus, vectorisés
// (dimension 1024, comme Amazon Titan Text Embeddings V2).
export const incidentVectorsTable = pgTable("incident_vectors", {
  vectorId: uuid("vector_id").primaryKey().defaultRandom(),
  errorMessageText: text("error_message_text").notNull(),
  embedding: vector1024("embedding").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type IncidentVector = typeof incidentVectorsTable.$inferSelect;

// Journal chronologique immuable de chaque action tentée par l'agent.
export const executionLogsTable = pgTable("execution_logs", {
  logId: uuid("log_id").primaryKey().defaultRandom(),
  incidentId: uuid("incident_id")
    .notNull()
    .references(() => incidentStateTable.incidentId),
  actionTaken: text("action_taken").notNull(),
  result: text("result"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ExecutionLog = typeof executionLogsTable.$inferSelect;

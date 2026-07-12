import {
  boolean,
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
  // Coordination multi-agents : quel agent (diagnostician/remediator/auditor)
  // détient actuellement le droit d'écrire sur cet incident. Réclamé et
  // libéré via une transaction CockroachDB (voir claimIncidentForAgent).
  claimedByAgent: varchar("claimed_by_agent", { length: 50 }),
  // Chaînage causal : cet incident a-t-il été déclenché en réaction à un
  // autre incident déjà résolu ? Auto-référence traversable par une CTE
  // récursive (WITH RECURSIVE) pour reconstruire une chaîne causale.
  causedByIncidentId: uuid("caused_by_incident_id"),
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
// (dimension 1024, comme Amazon Titan Text Embeddings V2). Chaque ligne
// porte aussi le nom de la stratégie de résolution employée et si elle a
// réussi, pour calculer un taux de succès par stratégie via une simple
// agrégation SQL (un bandit contextuel appuyé sur CockroachDB, pas un
// service ML externe).
export const incidentVectorsTable = pgTable("incident_vectors", {
  vectorId: uuid("vector_id").primaryKey().defaultRandom(),
  incidentId: uuid("incident_id").references(
    () => incidentStateTable.incidentId,
  ),
  errorMessageText: text("error_message_text").notNull(),
  embedding: vector1024("embedding").notNull(),
  strategyName: varchar("strategy_name", { length: 100 })
    .notNull()
    .default("default_repair"),
  outcomeSuccess: boolean("outcome_success").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type IncidentVector = typeof incidentVectorsTable.$inferSelect;

// Traçabilité des passations entre agents spécialisés (Diagnostician,
// Remediator, Auditor) : chaque réclamation/libération d'un incident est
// journalisée, avec le mode de décision retenu par le Remediator
// (autonomous / needs_approval / cautious) selon le score de similarité
// RAG. C'est la preuve que la mémoire vectorielle influence une vraie
// décision, pas seulement un affichage.
export const agentHandoffsTable = pgTable("agent_handoffs", {
  handoffId: uuid("handoff_id").primaryKey().defaultRandom(),
  incidentId: uuid("incident_id")
    .notNull()
    .references(() => incidentStateTable.incidentId),
  agentName: varchar("agent_name", { length: 50 }).notNull(),
  decisionMode: varchar("decision_mode", { length: 50 }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AgentHandoff = typeof agentHandoffsTable.$inferSelect;

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

import {
  boolean,
  customType,
  doublePrecision,
  integer,
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

// Core of resilience: one row per unique incident (deduplicated by
// alertFingerprint). contextJson holds the full agent turn history so it
// can resume exactly where it left off.
export const incidentStateTable = pgTable("incident_state", {
  incidentId: uuid("incident_id").primaryKey().defaultRandom(),
  alertFingerprint: varchar("alert_fingerprint", { length: 255 })
    .notNull()
    .unique(),
  status: varchar("status", { length: 50 }).notNull().default("TRIGGERED"),
  currentStep: varchar("current_step", { length: 100 }),
  contextJson: jsonb("context_json").notNull().default({}),
  // Multi-agent coordination: which agent (diagnostician/remediator/auditor)
  // currently holds the write lock on this incident. Claimed and released
  // via a CockroachDB transaction (see claimIncidentForAgent).
  claimedByAgent: varchar("claimed_by_agent", { length: 50 }),
  // Causal chaining: was this incident triggered as a side effect of another
  // already-resolved incident? Self-reference traversable by a recursive CTE
  // (WITH RECURSIVE) to reconstruct a causal chain.
  causedByIncidentId: uuid("caused_by_incident_id"),
  // MTTR and cost per incident
  // triggeredAt: alert arrival timestamp (immutable after INSERT)
  triggeredAt: timestamp("triggered_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // resolvedAt: updated when status transitions to RESOLVED or FAILED
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // ruConsumed: estimated CockroachDB Request Units consumed by this incident
  // (reads + writes + ANN vector search + serializable transactions)
  ruConsumed: integer("ru_consumed").notNull().default(0),
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

// RAG knowledge base: resolved error messages, vectorized at 1024 dimensions
// (matching Amazon Titan Text Embeddings V2). Each row also carries the
// resolution strategy used and whether it succeeded, enabling per-strategy
// success-rate computation via a simple SQL aggregation (a contextual bandit
// backed by CockroachDB, no external ML service).
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
  // Human feedback signal source:
  // "outcome" = automatic signal (incident resolution/failure)
  // "human"   = signal from a human decision (rejection or correction)
  signalSource: varchar("signal_source", { length: 10 })
    .notNull()
    .default("outcome"),
  // Signal weight: 1.0 for automatic outcomes,
  // 0.5 for human signals (less certainty than a real outcome).
  weight: doublePrecision("weight").notNull().default(1.0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type IncidentVector = typeof incidentVectorsTable.$inferSelect;

// Traceability of handoffs between specialized agents (Diagnostician,
// Remediator, Auditor): each claim/release of an incident is logged,
// along with the decision mode chosen by the Remediator
// (autonomous / needs_approval / cautious) based on the RAG similarity score.
// This proves that the vector memory influences a real decision, not just a display.
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

// Immutable chronological journal of every action attempted by the agent.
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

/**
 * Automatic strategy calibration (Layer 1 — self-correcting bandit)
 *
 * One row per strategy. Records:
 *  - avgPredictedWinRate: rolling average of win-rates predicted at the time of
 *    each routing decision (what we believed would happen)
 *  - observedWinRate: actual win-rate computed from incident_vectors
 *    (what actually happened, updated after each resolved incident)
 *  - correctionFactor: multiplicative factor applied to the raw win-rate in
 *    future decisions. 1.0 = neutral; < 1 = demoted; > 1 = promoted.
 *    Activated when |observed - predicted| > 15%.
 *
 * Entirely backed by CockroachDB — no external ML service.
 */
export const strategyCalibrationTable = pgTable("strategy_calibration", {
  strategyName: varchar("strategy_name", { length: 100 }).primaryKey(),
  /** Weighted rolling average of the win-rate predicted at each decision. */
  avgPredictedWinRate: doublePrecision("avg_predicted_win_rate").notNull().default(0.5),
  /** Actual observed win-rate (recomputed from incident_vectors). NULL if no data yet. */
  observedWinRate: doublePrecision("observed_win_rate"),
  /**
   * Correction factor applied to the raw win-rate in subsequent decisions.
   * = observed / predicted if |gap| > threshold (15%), otherwise 1.0.
   * Clamped to [0.1; 1.5].
   */
  correctionFactor: doublePrecision("correction_factor").notNull().default(1.0),
  /** Number of decisions recorded for this strategy. */
  predictionCount: integer("prediction_count").notNull().default(0),
  /**
   * Cumulative count of human signals received for this strategy
   * (rejections + corrections). Each human signal counts as 0.5 in the win-rate
   * instead of 1.0 for an automatic outcome — the memory stays cautious about
   * human judgments that may reflect preferences, not just the technical
   * performance of the strategy.
   */
  humanSignalCount: integer("human_signal_count").notNull().default(0),
  lastRecalculatedAt: timestamp("last_recalculated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StrategyCalibration = typeof strategyCalibrationTable.$inferSelect;

// ============================================================================
// Cloud-Surgeon — Shared Types
//
// Extracted from cloud-surgeon.ts to make the type surface explicit and
// importable by sub-modules without pulling in the full agent loop.
// ============================================================================

export type RoutingMode = "AUTONOMOUS" | "PENDING_APPROVAL" | "EXPLORATORY" | "REJECTED";
export type AgentName = "diagnostician" | "remediator" | "auditor";

export interface AgentTurn {
  turn: number;
  agent: AgentName;
  thought: string;
  thoughtSource: "anthropic" | "bedrock" | "simulated";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown>;
}

export interface RepairPlan {
  strategy: string;
  estimatedDuration: string;
  riskLevel: "low" | "medium" | "high";
  blastRadius: string;
  steps: string[];
  preconditions: string[];
  expectedOutcome: string;
  alternatives: string[];
  generatedBy: "llm" | "deterministic";
  generatedAt: string;
}

export interface RollbackInfo {
  steps: string[];
  estimatedTime: string;
  riskLevel: "low" | "medium" | "high";
  commandsExecuted: string[];
  warnings: string[];
  generatedAt: string;
}

export interface IncidentContext {
  alertText?: string;
  strategyName?: string;
  // Layer 2: routing decision and data that led to the decision
  routingMode?: RoutingMode;
  routingDecisionComputed?: boolean;
  ragScore?: number | null;         // cosine distance (0 = identical, 1 = opposite)
  ragStrategyHint?: string | null;  // strategy of the most similar historical incident
  winRate?: number | null;          // raw historical win-rate for the strategy
  winRateSampleSize?: number;       // number of samples used in the calculation
  // Layer 1 — automatic calibration
  correctionFactor?: number | null; // strategy correction factor (1.0 = neutral)
  effectiveWinRate?: number | null; // winRate * correctionFactor (used for routing)
  // Feature 2: pre-execution simulation plan
  repairPlan?: RepairPlan;
  // Feature 3: rollback info stored in context for quick access
  rollbackInfo?: RollbackInfo;
  turns?: AgentTurn[];
  finalResponse?: string | null;
  crashed?: boolean;
  [key: string]: unknown;
}

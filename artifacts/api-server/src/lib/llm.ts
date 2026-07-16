/**
 * Provider-agnostic LLM layer.
 *
 * Exports:
 *  - invokeLLMThought()  — per-agent-turn reasoning sentence (diagnostician / remediator / auditor)
 *  - invokeLLMText()     — generic single prompt → string (used for expectedOutcome enrichment, etc.)
 *
 * AI_PROVIDER=anthropic  → Anthropic Claude via Replit AI Integrations or direct API key.
 * AI_PROVIDER=bedrock    → Amazon Nova Lite via Bedrock Converse API (default, geo-unrestricted).
 */

import { invokeBedrockThought, invokeBedrockText } from "./bedrock";
import { logger } from "./logger";

// ── Fallback thought templates (used only when all providers fail) ─────────

const FALLBACK_THOUGHTS: Record<number, string> = {
  0: "Checking cluster health and recent deployment history before recommending any corrective action.",
  1: "Diagnostic data confirms degradation. Selecting the highest-confidence repair strategy from memory.",
  2: "Verifying repair outcome against success criteria and closing the incident record.",
};

function fallbackThought(turnIndex: number): string {
  return FALLBACK_THOUGHTS[turnIndex] ?? "Analyzing incident data and determining next action.";
}

// ── Optional metadata forwarded to prompts ────────────────────────────────

export interface LLMThoughtMeta {
  strategyName?: string;
  serviceName?: string;
  repairSuccess?: boolean;
}

// ── Prompt builder ─────────────────────────────────────────────────────────

export function buildThoughtPrompt(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
  meta?: LLMThoughtMeta,
): string {
  const strategy = meta?.strategyName;
  const service  = meta?.serviceName;

  if (turnIndex === 0) {
    return (
      `You are Cloud-Surgeon, an autonomous DevOps agent responding to a live infrastructure alert. ` +
      `Alert: "${alertText}". ` +
      (strategy ? `Likely failure mode: ${strategy}. ` : "") +
      `In one sentence, state the exact metric or cluster signal you will read first ` +
      `and why verifying it before acting prevents amplifying the incident.`
    );
  }

  if (turnIndex === 1) {
    const diag = priorToolOutput ? JSON.stringify(priorToolOutput).slice(0, 400) : "unavailable";
    return (
      `You are Cloud-Surgeon. Diagnostic result: ${diag}. ` +
      `Alert: "${alertText}". ` +
      (strategy ? `Repair strategy selected: "${strategy}". ` : "") +
      (service  ? `Target service: "${service}". ` : "") +
      `In one sentence, cite the specific finding in the diagnostic output that directly justifies ` +
      `this strategy over any alternative approach.`
    );
  }

  // Turn 2 — auditor
  const result = priorToolOutput ? JSON.stringify(priorToolOutput).slice(0, 400) : "unavailable";
  const outcome = meta?.repairSuccess === true ? "SUCCESS" : meta?.repairSuccess === false ? "FAILURE" : "unknown";
  return (
    `You are Cloud-Surgeon. Repair output: ${result}. ` +
    (strategy ? `Strategy applied: "${strategy}". ` : "") +
    `Declared outcome: ${outcome}. ` +
    `In one sentence, identify the specific field or metric in the output that confirms this outcome ` +
    `and state whether the service requires continued monitoring or the incident is fully closed.`
  );
}

// ── Anthropic path — lazy dynamic import ──────────────────────────────────

async function callAnthropicLLM(prompt: string): Promise<string | null> {
  if (process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
    try {
      const { anthropic } = await import("@workspace/integrations-anthropic-ai");
      const message = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });
      const block = message.content[0];
      return (block?.type === "text" ? block.text.trim() : null) ?? null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Anthropic (AI Integrations) failed");
      return null;
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });
      const block = message.content[0];
      return (block?.type === "text" ? block.text.trim() : null) ?? null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Anthropic (direct API key) failed");
      return null;
    }
  }

  logger.warn("AI_PROVIDER=anthropic but no API key set — falling back to simulated");
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export type ThoughtSource = "anthropic" | "bedrock" | "simulated";

export interface LLMThought {
  thought: string;
  source: ThoughtSource;
}

/**
 * Per-turn reasoning sentence for the agent loop.
 * Accepts optional meta (strategyName, serviceName, repairSuccess) to produce
 * richer, more specific prompts.
 */
export async function invokeLLMThought(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
  meta?: LLMThoughtMeta,
): Promise<LLMThought> {
  const provider = (process.env.AI_PROVIDER ?? "bedrock").toLowerCase();
  const prompt = buildThoughtPrompt(alertText, turnIndex, priorToolOutput, meta);

  if (provider === "anthropic") {
    const text = await callAnthropicLLM(prompt);
    if (text) {
      logger.info({ turnIndex, provider: "anthropic" }, "LLM thought generated");
      return { thought: text, source: "anthropic" };
    }
    return { thought: fallbackThought(turnIndex), source: "simulated" };
  }

  // Bedrock (Nova Lite) path
  const bedrockThought = await invokeBedrockThought(prompt);
  if (bedrockThought) {
    return { thought: bedrockThought, source: "bedrock" };
  }

  return { thought: fallbackThought(turnIndex), source: "simulated" };
}

/**
 * Generic single-prompt LLM call — used for plan enrichment, playbook generation,
 * and any one-off text generation that isn't tied to the agent turn loop.
 * Works with any configured provider.
 */
export async function invokeLLMText(prompt: string): Promise<string | null> {
  const provider = (process.env.AI_PROVIDER ?? "bedrock").toLowerCase();

  if (provider === "anthropic") {
    return callAnthropicLLM(prompt);
  }

  return invokeBedrockText(prompt);
}

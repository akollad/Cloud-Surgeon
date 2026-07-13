/**
 * Provider-agnostic LLM layer for agent reasoning ("thoughts").
 *
 * AI_PROVIDER=anthropic  → Anthropic Claude via Replit AI Integrations (dev).
 *                           @workspace/integrations-anthropic-ai is loaded lazily
 *                           with a dynamic import — only when this path is active.
 *                           Bedrock-mode startup never loads Anthropic env vars.
 *
 * AI_PROVIDER=bedrock    → Amazon Bedrock Claude via AWS SDK (production default).
 *                           No dependency on Anthropic env vars at any point.
 *
 * Returns a unified { thought, source } shape. Falls back to a deterministic
 * simulated thought only when every live provider fails — and always logs why.
 */

import { invokeBedrockThought } from "./bedrock";
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

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
): string {
  if (turnIndex === 0) {
    return (
      `You are an autonomous cloud-infrastructure DevOps agent (Cloud-Surgeon). ` +
      `An infrastructure alert has just fired: "${alertText}". ` +
      `In exactly one sentence, explain your reasoning for checking cluster and service status ` +
      `before taking any corrective action. Be specific about what signal you are looking for.`
    );
  }
  if (turnIndex === 1) {
    return (
      `You are an autonomous cloud-infrastructure DevOps agent (Cloud-Surgeon). ` +
      `Diagnostic result: ${JSON.stringify(priorToolOutput)}. ` +
      `In exactly one sentence, explain your reasoning for the repair strategy you are about ` +
      `to apply and why it is the most appropriate action given the diagnostic data above.`
    );
  }
  return (
    `You are an autonomous cloud-infrastructure DevOps agent (Cloud-Surgeon). ` +
    `Repair result: ${JSON.stringify(priorToolOutput)}. ` +
    `In exactly one sentence, summarize whether the repair succeeded, what evidence supports ` +
    `your conclusion, and whether any follow-up action is required.`
  );
}

// ── Anthropic path — lazy dynamic import ──────────────────────────────────
// The module is only imported when AI_PROVIDER=anthropic is active.
// This prevents the Anthropic client's startup validation from running
// in Bedrock/production mode where the integration env vars are absent.

async function callAnthropicLLM(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
): Promise<string | null> {
  const prompt = buildPrompt(alertText, turnIndex, priorToolOutput);

  // Prefer the Replit AI Integrations proxy when it is provisioned.
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
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), turnIndex },
        "Anthropic (AI Integrations) invocation failed — falling back to simulated",
      );
      return null;
    }
  }

  // Fall back to the user's own Anthropic API key when the proxy isn't provisioned.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await client.messages.create({
        model: "claude-3-5-haiku-latest",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      });
      const block = message.content[0];
      return (block?.type === "text" ? block.text.trim() : null) ?? null;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), turnIndex },
        "Anthropic (direct API key) invocation failed — falling back to simulated",
      );
      return null;
    }
  }

  logger.warn(
    "AI_PROVIDER=anthropic but neither AI_INTEGRATIONS_ANTHROPIC_BASE_URL nor ANTHROPIC_API_KEY is set — falling back to simulated",
  );
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export type ThoughtSource = "anthropic" | "bedrock" | "simulated";

export interface LLMThought {
  thought: string;
  source: ThoughtSource;
}

export async function invokeLLMThought(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
): Promise<LLMThought> {
  const provider = (process.env.AI_PROVIDER ?? "bedrock").toLowerCase();

  // ── Anthropic path (dev) ──────────────────────────────────────────────────
  if (provider === "anthropic") {
    const text = await callAnthropicLLM(alertText, turnIndex, priorToolOutput);
    if (text) {
      logger.info({ turnIndex, provider: "anthropic" }, "LLM thought generated");
      return { thought: text, source: "anthropic" };
    }
    return { thought: fallbackThought(turnIndex), source: "simulated" };
  }

  // ── Bedrock path (production default) ────────────────────────────────────
  // No Anthropic env vars are read on this path.
  const bedrockThought = await invokeBedrockThought(alertText, turnIndex, priorToolOutput);
  if (bedrockThought) {
    return { thought: bedrockThought, source: "bedrock" };
  }

  // ── Final fallback ────────────────────────────────────────────────────────
  return { thought: fallbackThought(turnIndex), source: "simulated" };
}

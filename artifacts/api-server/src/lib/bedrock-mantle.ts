/**
 * Amazon Bedrock-Mantle — OpenAI-compatible endpoint
 *
 * Base URL : https://bedrock-mantle.us-east-1.api.aws/v1
 * Auth     : Bearer BEDROCK_API_KEY  (no SigV4 required)
 * Format   : OpenAI chat/completions  (max_completion_tokens, not max_tokens)
 *
 * Confirmed working models (tested 2026-07-20):
 *   mistral.mistral-large-3-675b-instruct  — best quality, 340 ms
 *   deepseek.v3.2                          — excellent quality, 350 ms
 *   mistral.ministral-3-8b-instruct        — fast / cheap fallback, 310 ms
 */

import { logger } from "./logger";

const BASE_URL = "https://bedrock-mantle.us-east-1.api.aws/v1";

// Default model — Mistral Large 3 (675B). Override with BEDROCK_MANTLE_MODEL.
const DEFAULT_MODEL = "mistral.mistral-large-3-675b-instruct";

export function mantleIsConfigured(): boolean {
  return !!process.env.BEDROCK_API_KEY;
}

export function mantleModel(): string {
  return process.env.BEDROCK_MANTLE_MODEL ?? DEFAULT_MODEL;
}

interface MantleMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Single-turn chat completion via bedrock-mantle.
 * Returns the assistant text, or null on any error.
 */
export async function invokeMantleText(
  prompt: string,
  systemPrompt?: string,
  maxTokens = 400,
): Promise<string | null> {
  const apiKey = process.env.BEDROCK_API_KEY;
  if (!apiKey) return null;

  const model = mantleModel();
  const messages: MantleMessage[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`bedrock-mantle ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) {
      logger.warn({ model }, "[Mantle] Empty content in response");
      return null;
    }

    return text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), model },
      "[Mantle] invokeMantleText failed",
    );
    return null;
  }
}

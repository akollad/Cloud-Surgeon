import { logger } from "./logger";

// ----------------------------------------------------------------------------
// Amazon Bedrock invocation — eu-west-1, Amazon Nova Lite
//
// Uses the Bedrock Converse API (model-agnostic) instead of the Anthropic
// InvokeModel format.  Nova Lite is cheaper, fast, and sufficient for the
// one-sentence reasoning thoughts Cloud-Surgeon generates per agent turn.
//
// Authentication priority (first configured wins):
//   1. BEDROCK_API_KEY  → HTTP Bearer token (no SigV4, works from Replit).
//   2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY → AWS SDK SigV4.
//   3. Neither set → returns null; caller shows `thoughtSource: "simulated"`.
//
// Region: BEDROCK_REGION (default eu-west-1).
// Model:  EU cross-region inference profile for Nova Lite, direct ID fallback.
// ----------------------------------------------------------------------------

const REGION = process.env.BEDROCK_REGION ?? "eu-west-1";

// EU cross-region inference profile for Nova Lite.
const MODEL_ID_EU_PROFILE = "eu.amazon.nova-lite-v1:0";
// Direct on-demand model ID as fallback.
const MODEL_ID_DIRECT = "amazon.nova-lite-v1:0";

function buildConverseEndpoint(modelId: string): string {
  return `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
}

function buildRequestBody(prompt: string, systemPrompt?: string): string {
  const body: Record<string, unknown> = {
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 300 },
  };
  if (systemPrompt) {
    body.system = [{ text: systemPrompt }];
  }
  return JSON.stringify(body);
}

// Prompt is now built in llm.ts (buildThoughtPrompt) and passed in directly.
// This keeps all prompt logic in one place.

// ── Path 1: BEDROCK_API_KEY Bearer token ──────────────────────────────────

async function invokeWithApiKey(body: string, modelId: string): Promise<string | null> {
  const apiKey = process.env.BEDROCK_API_KEY;
  if (!apiKey) return null;

  const res = await fetch(buildConverseEndpoint(modelId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Bedrock Nova Lite [${modelId}] ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    output?: { message?: { content?: Array<{ text?: string }> } };
  };
  return payload?.output?.message?.content?.[0]?.text?.trim() || null;
}

// ── Path 2: AWS_ACCESS_KEY_ID SigV4 ──────────────────────────────────────

async function invokeWithSigV4(prompt: string, modelId: string, systemPrompt?: string): Promise<string | null> {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }

  const { BedrockRuntimeClient, ConverseCommand } =
    await import("@aws-sdk/client-bedrock-runtime");

  const client = new BedrockRuntimeClient({ region: REGION });
  const command = new ConverseCommand({
    modelId,
    ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 300 },
  });

  const response = await client.send(command);
  const text = response.output?.message?.content?.[0]?.text;
  return text?.trim() || null;
}

// ── Internal invoke (tries EU profile first, then direct model ID) ─────────

async function invokeModel(
  prompt: string,
  authFn: (b: string, m: string) => Promise<string | null>,
  systemPrompt?: string,
): Promise<{ result: string | null; modelId: string }> {
  const body = buildRequestBody(prompt, systemPrompt);

  try {
    const result = await authFn(body, MODEL_ID_EU_PROFILE);
    if (result !== null) return { result, modelId: MODEL_ID_EU_PROFILE };
  } catch (profileErr) {
    logger.debug(
      { err: profileErr instanceof Error ? profileErr.message : String(profileErr), modelId: MODEL_ID_EU_PROFILE },
      "EU Nova Lite inference profile failed, trying direct model ID",
    );
  }

  const result = await authFn(body, MODEL_ID_DIRECT);
  return { result, modelId: MODEL_ID_DIRECT };
}

// ── Public API ────────────────────────────────────────────────────────────

/** Returns true when at least one auth method is configured. */
export function bedrockIsConfigured(): boolean {
  return !!(
    process.env.BEDROCK_API_KEY ||
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  );
}

/** Returns the active auth method label for the boot log. */
export function bedrockAuthMethod(): "api-key" | "sigv4" | "none" {
  if (process.env.BEDROCK_API_KEY) return "api-key";
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return "sigv4";
  return "none";
}

/**
 * Core Nova Lite invocation — routes to API-key (Bearer/HTTP) or SigV4 (AWS SDK).
 * systemPrompt is passed as the `system` field in the Converse API request,
 * giving Nova Lite strategy-specific domain knowledge on every call.
 */
async function callNovaThin(prompt: string, logLabel: string, systemPrompt?: string): Promise<string | null> {
  const auth = bedrockAuthMethod();
  if (auth === "none") return null;

  const authFn =
    auth === "api-key"
      ? invokeWithApiKey
      : async (body: string, modelId: string) => invokeWithSigV4(prompt, modelId, systemPrompt);

  try {
    const { result, modelId } = await invokeModel(prompt, authFn, systemPrompt);
    if (result) {
      logger.info({ auth, region: REGION, modelId, label: logLabel }, "Bedrock Nova Lite response");
    }
    return result;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), region: REGION, auth, label: logLabel },
      "Bedrock Nova Lite invocation failed",
    );
    return null;
  }
}

/**
 * Per-turn reasoning sentence.  Prompt + system prompt built in llm.ts.
 */
export async function invokeBedrockThought(prompt: string, systemPrompt?: string): Promise<string | null> {
  return callNovaThin(prompt, "thought", systemPrompt);
}

/**
 * Generic text generation — plan/playbook enrichment.
 */
export async function invokeBedrockText(prompt: string, systemPrompt?: string): Promise<string | null> {
  return callNovaThin(prompt, "text", systemPrompt);
}

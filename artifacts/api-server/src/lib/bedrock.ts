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

function buildRequestBody(prompt: string): string {
  return JSON.stringify({
    messages: [
      {
        role: "user",
        content: [{ text: prompt }],
      },
    ],
    inferenceConfig: {
      maxTokens: 250,
    },
  });
}

function buildPrompt(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
): string {
  if (turnIndex === 0) {
    return (
      `You are Cloud-Surgeon, an autonomous DevOps agent. ` +
      `Alert: "${alertText}". ` +
      `In one sentence, explain why you will check cluster/service state before taking any corrective action.`
    );
  }
  return (
    `You are Cloud-Surgeon, an autonomous DevOps agent. ` +
    `Diagnostic result: ${JSON.stringify(priorToolOutput)}. ` +
    `In one sentence, explain your reasoning for the repair action you are about to apply.`
  );
}

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

async function invokeWithSigV4(body: string, modelId: string): Promise<string | null> {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }

  const { BedrockRuntimeClient, ConverseCommand } =
    await import("@aws-sdk/client-bedrock-runtime");

  const client = new BedrockRuntimeClient({ region: REGION });
  const command = new ConverseCommand({
    modelId,
    messages: [
      {
        role: "user",
        content: [{ text: body }], // body is already the prompt string here
      },
    ],
    inferenceConfig: { maxTokens: 250 },
  });

  const response = await client.send(command);
  const text = response.output?.message?.content?.[0]?.text;
  return text?.trim() || null;
}

// ── Internal invoke (tries EU profile first, then direct model ID) ─────────

async function invokeModel(
  prompt: string,
  authFn: (b: string, m: string) => Promise<string | null>,
): Promise<{ result: string | null; modelId: string }> {
  const body = buildRequestBody(prompt);

  // Try EU cross-region inference profile first.
  try {
    const result = await authFn(body, MODEL_ID_EU_PROFILE);
    if (result !== null) return { result, modelId: MODEL_ID_EU_PROFILE };
  } catch (profileErr) {
    logger.debug(
      { err: profileErr instanceof Error ? profileErr.message : String(profileErr), modelId: MODEL_ID_EU_PROFILE },
      "EU Nova Lite inference profile failed, trying direct model ID",
    );
  }

  // Fallback: direct on-demand model ID.
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

export async function invokeBedrockThought(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
): Promise<string | null> {
  const auth = bedrockAuthMethod();
  if (auth === "none") return null;

  const prompt = buildPrompt(alertText, turnIndex, priorToolOutput);

  // SigV4 path uses the ConverseCommand directly (not raw HTTP), so we pass the
  // prompt string and let invokeWithSigV4 build its own payload.
  // API-key path uses raw HTTP fetch with buildRequestBody(prompt).
  const authFn =
    auth === "api-key"
      ? invokeWithApiKey
      : async (body: string, modelId: string) => invokeWithSigV4(prompt, modelId);

  try {
    const { result, modelId } = await invokeModel(prompt, authFn);
    if (result) {
      logger.info(
        { turnIndex, auth, region: REGION, modelId },
        "Bedrock Nova Lite thought generated",
      );
    }
    return result;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), turnIndex, region: REGION, auth },
      "Bedrock Nova Lite invocation failed — falling back to simulated thought",
    );
    return null;
  }
}

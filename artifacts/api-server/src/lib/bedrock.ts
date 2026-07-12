import { logger } from "./logger";

// ----------------------------------------------------------------------------
// Amazon Bedrock invocation — eu-west-1, Claude Haiku 4.5
//
// Authentication priority (first configured wins):
//   1. BEDROCK_API_KEY  → HTTP Bearer token (new Bedrock API-key feature, no
//      SigV4 signing, works from any network including Replit containers).
//   2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY → AWS SDK SigV4 (traditional
//      IAM credentials for environments where IAM is preferred).
//   3. Neither set → returns null; caller shows `thoughtSource: "simulated"`.
//
// Region: BEDROCK_REGION (default eu-west-1 — user's Bedrock is in eu-west-1).
// Model:  EU cross-region inference profile, falls back to direct model ID.
// ----------------------------------------------------------------------------

const REGION = process.env.BEDROCK_REGION ?? "eu-west-1";

// EU cross-region inference profile resolves to the nearest available
// Claude Haiku 4.5 endpoint within the EU partition.
const MODEL_ID_EU_PROFILE = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
// Direct on-demand model ID as fallback if the profile is not accessible.
const MODEL_ID_DIRECT = "anthropic.claude-haiku-4-5-20251001-v1:0";

function buildEndpoint(modelId: string): string {
  return `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
}

function buildRequestBody(prompt: string): string {
  return JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 250,
    messages: [{ role: "user", content: prompt }],
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

  const res = await fetch(buildEndpoint(modelId), {
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
    throw new Error(`Bedrock [${modelId}] ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  }

  const payload = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return payload?.content?.[0]?.text?.trim() || null;
}

// ── Path 2: AWS_ACCESS_KEY_ID SigV4 ──────────────────────────────────────

async function invokeWithSigV4(body: string, modelId: string): Promise<string | null> {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }

  // Lazy import — only loaded on this path so SigV4 never runs in API-key mode.
  const { BedrockRuntimeClient, InvokeModelCommand } =
    await import("@aws-sdk/client-bedrock-runtime");

  const client = new BedrockRuntimeClient({ region: REGION });
  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body,
  });
  const response = await client.send(command);
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return payload?.content?.[0]?.text?.trim() || null;
}

// ── Internal invoke (tries EU profile first, then direct model ID) ─────────

async function invokeModel(
  body: string,
  authFn: (b: string, m: string) => Promise<string | null>,
): Promise<{ result: string | null; modelId: string }> {
  // Try EU cross-region inference profile first.
  try {
    const result = await authFn(body, MODEL_ID_EU_PROFILE);
    if (result !== null) return { result, modelId: MODEL_ID_EU_PROFILE };
  } catch (profileErr) {
    logger.debug(
      { err: profileErr instanceof Error ? profileErr.message : String(profileErr), modelId: MODEL_ID_EU_PROFILE },
      "EU inference profile failed, trying direct model ID",
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

  const body = buildRequestBody(buildPrompt(alertText, turnIndex, priorToolOutput));
  const authFn = auth === "api-key" ? invokeWithApiKey : invokeWithSigV4;

  try {
    const { result, modelId } = await invokeModel(body, authFn);
    if (result) {
      logger.info(
        { turnIndex, auth, region: REGION, modelId },
        "Bedrock thought generated",
      );
    }
    return result;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), turnIndex, region: REGION, auth },
      "Bedrock invocation failed — falling back to simulated thought",
    );
    return null;
  }
}

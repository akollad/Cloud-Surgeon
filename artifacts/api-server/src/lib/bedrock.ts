import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { logger } from "./logger";

// ----------------------------------------------------------------------------
// Real Amazon Bedrock call (Claude Haiku 4.5) to generate the "thought"
// reasoning for each agent turn, replacing static hardcoded text. Tool
// choice and execution remain deterministic (see cloud-surgeon.ts) — only
// the "reflection" part is delegated to a real LLM, which is sufficient to
// prove a real Bedrock call without making the demo unpredictable or unsafe.
//
// If AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are not configured, or if the
// call fails (e.g. model access not enabled in the Bedrock console), we
// return `null` and the caller falls back to simulated text — transparently,
// never silently (see the `thoughtSource` field).
// ----------------------------------------------------------------------------

// Claude 3.5 Haiku was retired; Claude Haiku 4.5 is only available as an
// "inference profile" (no direct on-demand invocation via raw modelId),
// so we use the global profile ID.
const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient | null {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }
  if (!client) {
    client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
  }
  return client;
}

export async function invokeBedrockThought(
  alertText: string,
  turnIndex: number,
  priorToolOutput: Record<string, unknown> | null,
): Promise<string | null> {
  const bedrock = getClient();
  if (!bedrock) return null;

  const prompt =
    turnIndex === 0
      ? `You are an autonomous DevOps agent. An infrastructure alert just arrived: "${alertText}". ` +
        `In one sentence, explain your reasoning for deciding to check cluster state before any corrective action.`
      : `You are an autonomous DevOps agent. After diagnostic (result: ${JSON.stringify(priorToolOutput)}), ` +
        `in one sentence, explain your reasoning for deciding to trigger a repair action.`;

  try {
    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const response = await bedrock.send(command);
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const text: string | undefined = payload?.content?.[0]?.text;
    return text?.trim() || null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Bedrock invocation failed, falling back to simulated thought",
    );
    return null;
  }
}

import { logger } from "./logger";
import { searchDocs } from "./doc-rag";

// ----------------------------------------------------------------------------
// Amazon Bedrock — Amazon Nova Lite via Converse API (eu-west-1)
//
// Supports:
//   - System prompts (strategy skills injected per call)
//   - Tool use loop: Nova Lite can call search_docs(query) to look up
//     AWS / CockroachDB docs when its training knowledge is insufficient.
//     Max 1 tool call per response; result re-injected as tool_result turn.
//
// Auth priority (first configured wins):
//   1. BEDROCK_API_KEY  → HTTP Bearer (no SigV4; works from Replit)
//   2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY → AWS SDK SigV4
//   3. Neither → returns null (caller shows thoughtSource: "simulated")
// ----------------------------------------------------------------------------

const REGION = process.env.BEDROCK_REGION ?? "eu-west-1";
const MODEL_ID_EU_PROFILE = "eu.amazon.nova-lite-v1:0";
const MODEL_ID_DIRECT     = "amazon.nova-lite-v1:0";

// ── Tool definition ────────────────────────────────────────────────────────
//
// Registered in every Converse request so Nova Lite can decide to call it.
// It queries doc_chunks (vector similarity) then falls back to a live URL fetch.

const SEARCH_DOCS_TOOL = {
  toolSpec: {
    name: "search_docs",
    description:
      "Search official AWS and CockroachDB documentation. " +
      "Call this when you need precise field names, API response formats, " +
      "metric definitions, or operational procedures not present in your training data.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language query describing what to look up (e.g. 'ECS DescribeServices rolloutState values')",
          },
        },
        required: ["query"],
      },
    },
  },
};

// ── Message types (Converse API wire format) ──────────────────────────────

type ContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }>; status: "success" | "error" } };

interface ConverseTurn {
  role: "user" | "assistant";
  content: ContentBlock[];
}

// ── Helper: execute tool call ──────────────────────────────────────────────

async function handleToolCall(
  name: string,
  input: Record<string, unknown>,
  toolUseId: string,
): Promise<ConverseTurn> {
  let resultText: string;
  try {
    if (name === "search_docs") {
      const query = typeof input.query === "string" ? input.query : JSON.stringify(input);
      logger.info({ query: query.slice(0, 80) }, "[Bedrock] Nova Lite called search_docs");
      resultText = await searchDocs(query);
    } else {
      resultText = `Unknown tool: ${name}`;
    }
  } catch (err) {
    resultText = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return {
    role: "user",
    content: [{ toolResult: { toolUseId, content: [{ text: resultText }], status: "success" } }],
  };
}

// ── Path 1: BEDROCK_API_KEY Bearer token ──────────────────────────────────

function buildConverseEndpoint(modelId: string): string {
  return `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
}

function buildRequestBody(messages: ConverseTurn[], systemPrompt?: string, maxTokens = 400): string {
  const body: Record<string, unknown> = {
    messages,
    toolConfig: { tools: [SEARCH_DOCS_TOOL] },
    inferenceConfig: { maxTokens },
  };
  if (systemPrompt) body.system = [{ text: systemPrompt }];
  return JSON.stringify(body);
}

async function converseWithApiKey(
  messages: ConverseTurn[],
  modelId: string,
  systemPrompt?: string,
  maxTokens?: number,
): Promise<{
  text: string | null;
  stopReason: string;
  assistantContent: ContentBlock[];
}> {
  const apiKey = process.env.BEDROCK_API_KEY;
  if (!apiKey) return { text: null, stopReason: "no-auth", assistantContent: [] };

  const res = await fetch(buildConverseEndpoint(modelId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: buildRequestBody(messages, systemPrompt, maxTokens),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Bedrock [${modelId}] ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    stopReason?: string;
    output?: { message?: { role?: string; content?: ContentBlock[] } };
  };

  const content = payload?.output?.message?.content ?? [];
  const textBlock = content.find((b): b is { text: string } => "text" in b);
  return {
    text: textBlock?.text?.trim() ?? null,
    stopReason: payload.stopReason ?? "end_turn",
    assistantContent: content,
  };
}

// ── Path 2: AWS_ACCESS_KEY_ID SigV4 ──────────────────────────────────────

async function converseWithSigV4(
  messages: ConverseTurn[],
  modelId: string,
  systemPrompt?: string,
  maxTokens = 400,
): Promise<{
  text: string | null;
  stopReason: string;
  assistantContent: ContentBlock[];
}> {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return { text: null, stopReason: "no-auth", assistantContent: [] };
  }

  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: REGION });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const command = new ConverseCommand({
    modelId,
    ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
    messages: messages as Parameters<typeof ConverseCommand>[0]["messages"],
    toolConfig: { tools: [SEARCH_DOCS_TOOL] as Parameters<typeof ConverseCommand>[0]["toolConfig"]["tools"] },
    inferenceConfig: { maxTokens },
  });

  const response = await client.send(command);
  const content = (response.output?.message?.content ?? []) as ContentBlock[];
  const textBlock = content.find((b): b is { text: string } => "text" in b);
  return {
    text: textBlock?.text?.trim() ?? null,
    stopReason: response.stopReason ?? "end_turn",
    assistantContent: content,
  };
}

// ── Core: conversation loop with tool use ─────────────────────────────────
//
// Sends the initial request. If Nova Lite responds with stopReason="tool_use",
// executes the requested tool and sends a follow-up turn (max 1 tool call).
// Returns the final text response.

async function converseLoop(
  prompt: string,
  modelId: string,
  auth: "api-key" | "sigv4",
  systemPrompt?: string,
  maxTokens?: number,
): Promise<string | null> {
  const converse = auth === "api-key" ? converseWithApiKey : converseWithSigV4;
  const messages: ConverseTurn[] = [{ role: "user", content: [{ text: prompt }] }];

  // Turn 1 — initial response
  const turn1 = await converse(messages, modelId, systemPrompt, maxTokens);

  if (turn1.stopReason !== "tool_use") {
    // No tool call — return text directly
    return turn1.text;
  }

  // Nova Lite wants to call a tool — find the toolUse block
  const toolUseBlock = turn1.assistantContent.find(
    (b): b is { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } } => "toolUse" in b,
  );

  if (!toolUseBlock) return turn1.text;

  const { toolUseId, name, input } = toolUseBlock.toolUse;

  // Execute the tool
  const toolResultTurn = await handleToolCall(name, input, toolUseId);

  // Turn 2 — send tool result, get final response
  const messages2: ConverseTurn[] = [
    ...messages,
    { role: "assistant", content: turn1.assistantContent },
    toolResultTurn,
  ];

  const turn2 = await converse(messages2, modelId, systemPrompt, maxTokens);
  return turn2.text ?? turn1.text; // fall back to partial text from turn 1 if turn 2 fails
}

// ── Internal invoke (EU profile first, direct model ID fallback) ──────────

async function callNovaThin(
  prompt: string,
  logLabel: string,
  systemPrompt?: string,
  maxTokens?: number,
): Promise<string | null> {
  const auth = bedrockAuthMethod();
  if (auth === "none") return null;

  try {
    // Try EU cross-region inference profile first
    let result: string | null = null;
    try {
      result = await converseLoop(prompt, MODEL_ID_EU_PROFILE, auth, systemPrompt, maxTokens);
      if (result !== null) {
        logger.info({ auth, region: REGION, modelId: MODEL_ID_EU_PROFILE, label: logLabel }, "Bedrock Nova Lite response");
        return result;
      }
    } catch (profileErr) {
      logger.debug(
        { err: profileErr instanceof Error ? profileErr.message : String(profileErr), modelId: MODEL_ID_EU_PROFILE },
        "EU Nova Lite profile failed, trying direct model ID",
      );
    }
    // Fallback: direct on-demand model ID
    result = await converseLoop(prompt, MODEL_ID_DIRECT, auth, systemPrompt, maxTokens);
    if (result !== null) {
      logger.info({ auth, region: REGION, modelId: MODEL_ID_DIRECT, label: logLabel }, "Bedrock Nova Lite response");
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

// ── Public API ────────────────────────────────────────────────────────────

export function bedrockIsConfigured(): boolean {
  return !!(
    process.env.BEDROCK_API_KEY ||
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  );
}

export function bedrockAuthMethod(): "api-key" | "sigv4" | "none" {
  if (process.env.BEDROCK_API_KEY) return "api-key";
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return "sigv4";
  return "none";
}

/** Per-turn reasoning sentence. Prompt + system prompt built in llm.ts. */
export async function invokeBedrockThought(prompt: string, systemPrompt?: string): Promise<string | null> {
  return callNovaThin(prompt, "thought", systemPrompt);
}

/** Generic text generation — plan/playbook enrichment. */
export async function invokeBedrockText(prompt: string, systemPrompt?: string, maxTokens?: number): Promise<string | null> {
  return callNovaThin(prompt, "text", systemPrompt, maxTokens);
}

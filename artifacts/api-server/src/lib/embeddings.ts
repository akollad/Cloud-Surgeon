/**
 * Provider-agnostic embedding layer.
 *
 * AI_PROVIDER=anthropic  → Voyage AI voyage-3-lite (1024 dims) via VOYAGE_API_KEY.
 *                           If VOYAGE_API_KEY is absent, falls back to a
 *                           deterministic pseudo-embedding (logged explicitly).
 *                           Voyage AI is Anthropic's embedding partner;
 *                           voyage-3-lite outputs 1024 dims — matches
 *                           the VECTOR(1024) CockroachDB schema exactly.
 *                           Free tier: https://dash.voyageai.com
 *
 * AI_PROVIDER=bedrock    → Amazon Titan Text Embeddings V2 (1024 dims) via
 *                           Bedrock — matches the VECTOR(1024) CockroachDB schema
 *                           exactly (production default).
 *
 * Falls back to a deterministic pseudo-embedding only if every live provider
 * fails. The fallback is logged explicitly — never silent.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { createHash } from "node:crypto";
import { logger } from "./logger";

// ── Bedrock Titan client (lazy) ───────────────────────────────────────────

let _bedrockClient: BedrockRuntimeClient | null = null;

function getBedrockClient(): BedrockRuntimeClient | null {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }
  if (!_bedrockClient) {
    _bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? "us-east-1",
    });
  }
  return _bedrockClient;
}

async function invokeTitanEmbedding(text: string): Promise<number[] | null> {
  const client = getBedrockClient();
  if (!client) return null;
  try {
    const command = new InvokeModelCommand({
      modelId: "amazon.titan-embed-text-v2:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text.trim(), dimensions: 1024, normalize: true }),
    });
    const response = await client.send(command);
    const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
      embedding?: number[];
    };
    return payload.embedding ?? null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Bedrock Titan embedding failed",
    );
    return null;
  }
}

// ── Voyage AI embeddings (anthropic provider path) ───────────────────────
//
// Voyage AI is Anthropic's embedding partner. Set VOYAGE_API_KEY to enable
// real 1024-dim semantic embeddings (voyage-3-lite). Free tier: 200M tokens.
// Get a key at: https://dash.voyageai.com
//
// Without VOYAGE_API_KEY, falls back to pseudo-embedding (logged explicitly).

type VoyageEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
  error?: { message: string };
};

async function invokeVoyageEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "voyage-3-lite",  // 1024 dims — matches VECTOR(1024) schema exactly
        input: text.trim(),
      }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: { message: string } };
      logger.warn({ status: res.status, error: body.error?.message }, "Voyage AI embedding error");
      return null;
    }
    const data = (await res.json()) as VoyageEmbeddingResponse;
    return data.data[0]?.embedding ?? null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Voyage AI embedding request failed",
    );
    return null;
  }
}

// ── Pseudo-embedding fallback (deterministic, no external API) ────────────
// Kept as a last-resort fallback only. All distances will be ~0.93 so RAG
// similarity is meaningless — but the pipeline keeps running without crashing.

function pseudoEmbedding(text: string): number[] {
  let x = BigInt("0x" + createHash("sha256").update(text.trim()).digest("hex"));
  const mask = (1n << 31n) - 1n;
  const vec: number[] = [];
  for (let i = 0; i < 1024; i++) {
    x = (1103515245n * x + 12345n) & mask;
    vec.push((Number(x) / Number(mask)) * 2 - 1);
  }
  return vec;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function generateEmbedding(text: string): Promise<number[]> {
  const provider = (process.env.AI_PROVIDER ?? "bedrock").toLowerCase();

  if (provider === "anthropic") {
    const vec = await invokeVoyageEmbedding(text);
    if (vec) {
      logger.info({ provider: "voyage-ai", dims: vec.length }, "Real embedding generated");
      return vec;
    }
    // No VOYAGE_API_KEY set — pseudo-embedding fallback (explicit, never silent).
    // LLM thoughts are still real (Anthropic). Set VOYAGE_API_KEY to enable semantic RAG.
    logger.warn(
      { hint: "Set VOYAGE_API_KEY for real 1024-dim embeddings (https://dash.voyageai.com)" },
      "Voyage AI key not configured — using pseudo-embedding fallback",
    );
    return pseudoEmbedding(text);
  }

  // Bedrock path (production default)
  const vec = await invokeTitanEmbedding(text);
  if (vec) {
    logger.info({ provider: "bedrock-titan", dims: vec.length }, "Real embedding generated");
    return vec;
  }
  logger.warn("Bedrock Titan embedding unavailable — using pseudo-embedding fallback");
  return pseudoEmbedding(text);
}

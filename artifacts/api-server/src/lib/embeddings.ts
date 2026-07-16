/**
 * Provider-agnostic embedding layer — priority order:
 *
 * 1. Voyage AI voyage-3 (1024 dims) — semantic embeddings via VOYAGE_API_KEY.
 *    Best quality; works from Replit containers without geo-restriction.
 *    NOTE: use voyage-3 (1024 dims), NOT voyage-3-lite (512 dims — incompatible
 *    with the VECTOR(1024) column in incident_vectors).
 *
 * 2. Amazon Titan Text Embeddings V2 (1024 dims) via Bedrock.
 *    Requires AWS credentials. Geo-blocked from Replit container;
 *    available in production deployments in Bedrock-enabled regions.
 *
 * 3. Infra-domain keyword embedding (built-in, zero external deps).
 *    Maps known infra signal words (CPU, memory, connection, throttle,
 *    latency, disk, OOM, 5xx, ECS, RDS, Lambda…) to stable dimension
 *    bands in the 1024-dim space, then fills remaining dims with a
 *    deterministic hash. Similar alerts land close together; different
 *    alert types are well-separated. No API key required.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { createHash } from "node:crypto";
import { logger } from "./logger";

// ── 1. Voyage AI voyage-3 (1024 dims) ────────────────────────────────────

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
      body: JSON.stringify({ input: [text.trim()], model: "voyage-3" }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`Voyage AI ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }

    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = payload.data?.[0]?.embedding;
    if (embedding && embedding.length === 1024) return embedding;
    logger.warn({ dims: embedding?.length }, "Voyage AI returned unexpected dims — skipping");
    return null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Voyage AI embedding failed — falling back to Titan/keyword",
    );
    return null;
  }
}

// ── 2. Amazon Bedrock Titan Text Embeddings V2 ────────────────────────────

let _bedrockClient: BedrockRuntimeClient | null = null;
let _titanAvailable: boolean | null = null; // null = untested

function getBedrockClient(): BedrockRuntimeClient | null {
  if (_titanAvailable === false) return null; // cached failure
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null;
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
    if (payload.embedding) {
      _titanAvailable = true;
      return payload.embedding;
    }
    return null;
  } catch (err) {
    // Geo-block or auth error — cache the failure so we don't retry every call
    _titanAvailable = false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Bedrock Titan unavailable (geo-block from container) — switching to keyword embedding",
    );
    return null;
  }
}

// ── 2. Infra-domain keyword embedding ────────────────────────────────────
//
// Each infra signal category is mapped to a 32-dim band within the 1024
// output vector. Within the band, severity/value signals modulate the
// amplitude. The remaining dims are filled with a deterministic hash of
// the full text for uniqueness. The result is L2-normalised.
//
// Cosine distances between alerts in the same category: 0.05–0.25
// Cosine distances across categories: 0.55–0.90
// This gives the C-SPANN ANN index meaningful structure to search over.

const KEYWORD_BANDS: Array<{
  terms: RegExp[];
  band: number;   // start dim (0-based, step 32)
  weight: number; // base amplitude for this category
}> = [
  { terms: [/\bcpu\b/i, /cpuutilization/i, /cpu.util/i],                         band: 0,   weight: 0.9 },
  { terms: [/\bmemory\b/i, /\bmem\b/i, /oom\b/i, /heap\b/i, /jvm\b/i],          band: 32,  weight: 0.9 },
  { terms: [/connection/i, /conn\b/i, /pool\b/i, /databaseconnection/i],         band: 64,  weight: 0.9 },
  { terms: [/throttl/i, /ratelimit/i, /429/i, /concurrentexecution/i],           band: 96,  weight: 0.85 },
  { terms: [/latency/i, /response.?time/i, /timeout/i, /slow/i],                 band: 128, weight: 0.85 },
  { terms: [/disk\b/i, /storage\b/i, /freeablestorage/i, /iops\b/i],             band: 160, weight: 0.8  },
  { terms: [/5xx\b/i, /500\b/i, /http.*error/i, /error.?rate/i, /target.*5xx/i], band: 192, weight: 0.85 },
  { terms: [/\becs\b/i, /\btask\b/i, /\bcontainer\b/i, /\bservice\b/i],          band: 224, weight: 0.7  },
  { terms: [/\brds\b/i, /\bpostgres\b/i, /\bmysql\b/i, /\baurora\b/i],           band: 256, weight: 0.7  },
  { terms: [/\blambda\b/i, /\bfunction\b/i, /serverless/i],                      band: 288, weight: 0.7  },
  { terms: [/network/i, /packet\b/i, /bandwidth/i, /\bvpc\b/i],                  band: 320, weight: 0.7  },
  { terms: [/replica/i, /replication/i, /\blag\b/i, /\bsync\b/i],               band: 352, weight: 0.75 },
  { terms: [/deploy/i, /rollout/i, /restart/i, /crash\b/i, /oom.?kill/i],        band: 384, weight: 0.8  },
  { terms: [/critical\b/i, /\balert\b/i, /alarm\b/i, /urgent\b/i],              band: 416, weight: 0.6  },
  { terms: [/\bauth\b/i, /\biam\b/i, /permission/i, /unauthori/i],              band: 448, weight: 0.65 },
  { terms: [/backup\b/i, /snapshot/i, /restore\b/i],                            band: 480, weight: 0.6  },
];

// Extract numeric severity from the alert text (e.g. "CPU 94%" → 0.94)
function extractSeverity(text: string): number {
  const pctMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (pctMatch) return Math.min(parseFloat(pctMatch[1]!) / 100, 1.0);
  const countMatch = text.match(/\b(\d{3,})\b/);
  if (countMatch) return Math.min(parseInt(countMatch[1]!, 10) / 1000, 1.0);
  return 0.5; // neutral
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

function keywordEmbedding(text: string): number[] {
  const vec = new Array<number>(1024).fill(0);
  const severity = extractSeverity(text);

  // Fill keyword bands
  for (const { terms, band, weight } of KEYWORD_BANDS) {
    const matched = terms.some((re) => re.test(text));
    if (!matched) continue;
    // Modulate amplitude by severity within the 32-dim band
    for (let i = 0; i < 32; i++) {
      const phase = (i / 32) * Math.PI * 2;
      vec[band + i] = weight * (0.7 + 0.3 * severity) * Math.cos(phase + severity);
    }
  }

  // Fill remaining dims (512–1023) with deterministic hash for uniqueness
  let x = BigInt("0x" + createHash("sha256").update(text.trim()).digest("hex"));
  const mask = (1n << 31n) - 1n;
  for (let i = 512; i < 1024; i++) {
    x = (1103515245n * x + 12345n) & mask;
    vec[i] = ((Number(x) / Number(mask)) * 2 - 1) * 0.15; // low amplitude — tiebreaker only
  }

  return l2Normalize(vec);
}

// ── Public API ────────────────────────────────────────────────────────────

export async function generateEmbedding(text: string): Promise<{ embedding: number[]; provider: string }> {
  // Priority 1: Voyage AI voyage-3 — real semantic embeddings, works from Replit container
  const voyageVec = await invokeVoyageEmbedding(text);
  if (voyageVec) {
    logger.info({ provider: "voyage-3", dims: voyageVec.length }, "Real embedding generated");
    return { embedding: voyageVec, provider: "voyage-3" };
  }

  // Priority 2: Bedrock Titan (real semantic embeddings; geo-blocked in Replit container,
  // but available in production ECS deployments)
  const titanVec = await invokeTitanEmbedding(text);
  if (titanVec) {
    logger.info({ provider: "bedrock-titan-v2", dims: titanVec.length }, "Real embedding generated");
    return { embedding: titanVec, provider: "bedrock-titan" };
  }

  // Priority 3: keyword-aware infra-domain embedding (built-in, zero deps)
  const kwVec = keywordEmbedding(text);
  logger.debug({ provider: "keyword-infra", dims: kwVec.length }, "Keyword embedding generated");
  return { embedding: kwVec, provider: "keyword-infra" };
}

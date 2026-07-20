---
name: Mistral Large 3 via bedrock-mantle (AI_PROVIDER=mistral)
description: Current default LLM provider; uses bedrock-mantle OpenAI-compat endpoint with Bearer BEDROCK_API_KEY; Nova Lite is automatic tier-2 fallback.
---

**Rule:** `AI_PROVIDER=mistral` is the production default. Do not switch to `bedrock` or `anthropic` without a reason — Mistral Large 3 produces measurably better structured reasoning for incident diagnosis.

**Why:** Anthropic (Claude) is geo-restricted from Replit's server IP ranges (ECS is fine). Titan Text models are end-of-life. Nova Lite works but produces vaguer reasoning sentences. Mistral Large 3 via bedrock-mantle gives specific metric-name citations and causal reasoning in under 500 ms.

**How it works:**
- Module: `artifacts/api-server/src/lib/bedrock-mantle.ts`
- Endpoint: `https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions`
- Auth: `Authorization: Bearer <BEDROCK_API_KEY>` — no SigV4, no AWS SDK required
- Format: OpenAI chat/completions — use `max_completion_tokens` (not `max_tokens`)
- Default model: `mistral.mistral-large-3-675b-instruct` (override with `BEDROCK_MANTLE_MODEL`)

**Fallback chain (all transparent, no operator action needed):**
1. bedrock-mantle → Mistral Large 3 (`source: "mistral"`)
2. Bedrock Converse API → Nova Lite (`source: "bedrock"`) — if mantle returns null
3. Deterministic template (`source: "simulated"`) — if Nova Lite also fails

The `source` field on every `LLMThought` records which tier actually responded.

**Other confirmed working models on bedrock-mantle (tested 2026-07-20):**
- `deepseek.v3.2` — excellent quality, ~350 ms
- `mistral.ministral-3-8b-instruct` — fast/cheap, ~310 ms
- Claude and GPT-5.x do NOT support `/v1/chat/completions` on this endpoint

**Production config (ECS task def rev 13):**
- `AI_PROVIDER=mistral` as plain env var in task definition
- `BEDROCK_API_KEY` injected from `cloud-surgeon/prod` Secrets Manager secret

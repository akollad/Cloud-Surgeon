---
name: Bedrock geo-block and CockroachDB Cloud API permission gotchas
description: Two environment/config blockers hit wiring real AWS Bedrock and CockroachDB Cloud API calls from this Replit container; not fixable by changing app code.
---

**Bedrock (Anthropic models) geo-block:** invoking any Anthropic model on
Bedrock from this Replit container returns `Access to Anthropic models is
not allowed from unsupported countries, regions, or territories` even with
valid AWS credentials and `AWS_REGION` set to a supported region. This is
Anthropic-side geographic filtering based on the calling infrastructure's
apparent location, not an AWS credentials/permissions problem — no
AWS_REGION change or model-ID change fixes it. Non-Anthropic Bedrock models
(Titan, etc.) may still work; only Anthropic models are geo-restricted this
way.

**How to apply:** if a task needs a real Bedrock call to an Anthropic model,
verify early (single smoke-test invocation) before building the rest of the
feature around it — this is a hard external blocker discovered only at
invocation time, not something `ListFoundationModels`/`ListInferenceProfiles`
reveals in advance.

**Bedrock Claude 3.5 Haiku is EOL as of ~mid-2026:**
`anthropic.claude-3-5-haiku-20241022-v1:0` returns "this model version has
reached end of life." Newer Anthropic models on Bedrock (Claude Haiku 4.5,
Sonnet 4.x, Opus 4.x) are `INFERENCE_PROFILE`-only — they cannot be invoked
by raw modelId; use an inference profile ID instead, e.g.
`global.anthropic.claude-haiku-4-5-20251001-v1:0` (discover via
`ListInferenceProfilesCommand` from `@aws-sdk/client-bedrock`, not
`client-bedrock-runtime`).

**CockroachDB Cloud API `403 unauthorized`:** a valid-looking
`COCKROACH_CLOUD_API_KEY` + `COCKROACH_CLOUD_CLUSTER_ID` can still get
`{"code":7,"message":"unauthorized"}` from `GET /api/v1/clusters/{id}`. The
service account behind the key needs an explicit role (Cluster Admin /
Cluster Read) assigned to that specific cluster in the CockroachDB Cloud
console — creating the API key alone is not sufficient. Confirmed fix:
assigning the role in the console resolved it immediately, no code/endpoint
change needed (base path is `https://cockroachlabs.cloud/api/v1`, not
`/api/v2`).

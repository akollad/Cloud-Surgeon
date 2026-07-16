---
name: Bedrock geo-block & CockroachDB Cloud API perms
description: Anthropic-on-Bedrock geo-restricted from Replit container; Bearer token does NOT bypass it. CockroachDB Cloud API key needs role assigned per-cluster.
---

## Bedrock geo-block (Anthropic models only — resolved by switching to Nova Lite)

Anthropic models via Amazon Bedrock (`anthropic.claude-*`) return HTTP 400 "Access to Anthropic models is not allowed from unsupported countries/regions" from Replit containers. This applies to us-east-1 and eu-west-1, via both SigV4 and Bearer token.

**Resolution**: Switch to Amazon Nova Lite (`eu.amazon.nova-lite-v1:0`). Amazon's own models are NOT geo-blocked. Nova Lite responds HTTP 200 from Replit containers using `BEDROCK_API_KEY` Bearer token auth against the `/converse` endpoint.

**Current setup**: `AI_PROVIDER=bedrock`, `bedrock.ts` uses the Converse API with Nova Lite. `ANTHROPIC_API_KEY` is no longer required.

**Why:** Geo-restriction is Anthropic's policy on their own models, not a Bedrock-wide restriction.

## CockroachDB Cloud API key permissions

The Cloud API key must have a role explicitly assigned to each cluster in the CockroachDB Cloud console. A key with no cluster-level role returns 403 on cluster-scoped endpoints even if the key itself is valid.

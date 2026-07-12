---
name: Bedrock geo-block & CockroachDB Cloud API perms
description: Anthropic-on-Bedrock geo-restricted from Replit container; Bearer token does NOT bypass it. CockroachDB Cloud API key needs role assigned per-cluster.
---

## Bedrock geo-block

Anthropic models via Amazon Bedrock return HTTP 400 "Access to Anthropic models is not allowed from unsupported countries/regions" when called from Replit's container infrastructure.

- Applies to **us-east-1** AND **eu-west-1**.
- Applies to both **SigV4** (AWS SDK) and **Bearer token** (new Bedrock API key feature). Neither auth path bypasses the geo-restriction.
- `BEDROCK_API_KEY` is set and valid, but calls still fail.

**Workaround**: Use `AI_PROVIDER=anthropic` which routes through the Replit AI Integrations proxy (`AI_INTEGRATIONS_ANTHROPIC_API_KEY` / `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`). This works from the container and gives real Claude responses.

**Why:** Anthropic's content delivery policy restricts model access by the requester's IP geography, not by the auth method. Replit's container IPs are in a geo-blocked region from Anthropic's perspective.

**How to apply:** Always set `AI_PROVIDER=anthropic` in the shared env vars for this project. Keep the Bedrock code in place (`bedrock.ts`) as a future-proof path for deployment environments where the geo-block doesn't apply.

## CockroachDB Cloud API key permissions

The Cloud API key must have a role explicitly assigned to each cluster in the CockroachDB Cloud console. A key with no cluster-level role returns 403 on cluster-scoped endpoints even if the key itself is valid.

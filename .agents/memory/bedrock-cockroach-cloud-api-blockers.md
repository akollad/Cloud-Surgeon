---
name: Bedrock Nova Lite & CockroachDB Cloud API perms
description: Bedrock Nova Lite works fine from Replit containers. Earlier geo-restriction (Anthropic-on-Bedrock) is no longer applicable. CockroachDB Cloud API key needs role assigned per-cluster.
---

## Bedrock from Replit containers

Amazon Bedrock Nova Lite (`eu.amazon.nova-lite-v1:0`) works without geo-restriction from Replit containers using `BEDROCK_API_KEY` Bearer token auth. `AI_PROVIDER=bedrock` + `BEDROCK_REGION=eu-west-1` is the correct setup.

**Note:** An earlier session recorded that Anthropic-on-Bedrock (`anthropic.claude-*`) was geo-restricted. The user confirmed in July 2026 that this restriction is no longer in effect. Do not switch away from Bedrock based on stale geo-block assumptions.

## CockroachDB Cloud API key permissions

The Cloud API key must have a role explicitly assigned to each cluster in the CockroachDB Cloud console. A key with no cluster-level role returns 403 on cluster-scoped endpoints even if the key itself is valid.

---
name: AI Integrations Anthropic proxy needs an account upgrade the user may decline
description: setupReplitAIIntegrations for Anthropic can require a plan upgrade; users may decline it, so keep a direct-API-key fallback path.
---

Calling `setupReplitAIIntegrations({providerSlug:"anthropic"})` can prompt the user for an account upgrade before it will provision `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`. Users sometimes decline the upgrade but still want live AI, having provided their own `ANTHROPIC_API_KEY` secret instead.

**Why:** on Cloud-Surgeon the user declined the upgrade after providing an `ANTHROPIC_API_KEY`. The existing LLM layer only supported the AI Integrations proxy, so it silently fell back to simulated output with no path to use the user's own key.

**How to apply:** when building an LLM call path, support both: (1) the AI Integrations proxy when its base URL env var is present, (2) a direct SDK call (e.g. `@anthropic-ai/sdk`) using the user's own API key as a fallback. Always report which path actually produced the result (e.g. a `source` field) rather than presenting a simulated/fallback result as live.

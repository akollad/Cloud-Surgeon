---
name: CDC webhook token authentication pattern
description: How to authenticate CockroachDB changefeed webhook sinks without custom headers.
---

## Rule
CockroachDB changefeed sinks cannot send custom HTTP headers. Authenticate via a shared secret in the query parameter:
```
webhook-https://<host>/api/internal/cdc?token=<CDC_WEBHOOK_SECRET>
```

## Implementation
- `CDC_WEBHOOK_SECRET` env var: generate with `openssl rand -hex 32`.
- `artifacts/api-server/src/lib/cdc.ts`: appends `?token=<secret>` to the changefeed URL when the env var is set.
- `artifacts/api-server/src/routes/stream.ts`: validates `req.query.token === process.env.CDC_WEBHOOK_SECRET`. Returns 401 on mismatch. Skips validation when env var is unset (local dev).
- **Existing changefeed migration**: if `CDC_WEBHOOK_SECRET` is set but the running changefeed description does not contain `?token=`, `initChangefeed()` cancels the job and recreates it with the token. This is automatic on the next server restart.

**Why:** Without a token, any public actor who knows the endpoint URL can inject fake CDC events and broadcast arbitrary audit events to all dashboard subscribers.

**How to apply:** Add `CDC_WEBHOOK_SECRET` to Secrets Manager + ECS task definition. Restart the API server once — the old unauthenticated changefeed is cancelled and a new authenticated one is created automatically.

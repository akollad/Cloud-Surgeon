---
name: node:24-slim missing curl for ECS health check
description: node:24-slim (Debian bookworm-slim) does not include curl — ECS container health checks using CMD-SHELL curl silently fail while the app is healthy.
---

# node:24-slim — curl not included

**Rule:** Always install `curl` explicitly in any `node:24-slim` runtime stage that uses an ECS container health check of the form `CMD-SHELL curl -f http://localhost:PORT/healthz`.

**Why:** `node:24-slim` is Debian bookworm-slim and ships without curl. The ECS container health check runs `curl` via docker exec inside the container. If curl is absent, the command exits non-zero on every attempt → ECS marks the task as failed after 3 retries and stops it — even though the app is perfectly healthy. The ALB health check (HTTP, external) still returns 200 and appears in application logs, which makes the failure very confusing to diagnose.

**How to apply:** Add to the runtime stage of the Dockerfile, before WORKDIR:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
```

Do NOT switch the runtime to `node:24-alpine` to get curl — the ccloud binary is glibc and is incompatible with Alpine's musl libc.

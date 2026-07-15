---
name: ccloud binary path — single source of truth
description: All files must import CCLOUD_BINARY from lib/ccloud-path.ts; never redefine the path inline or the prod/dev logic silently breaks.
---

## Rule
Import `CCLOUD_BINARY` from `artifacts/api-server/src/lib/ccloud-path.ts`. Never compute the path inline.

**Why:** The path is environment-dependent (prod ECS: `/usr/local/bin/ccloud`, dev Replit: `.tools/ccloud` at workspace root). Inline redefinitions were silently using the wrong path in production, causing `ccloud auth whoami` failures even though credentials were written correctly.

**How to apply:**
```ts
import { CCLOUD_BINARY } from "../lib/ccloud-path";
```
Files that previously had this bug: `index.ts` (fixed). Verified clean: `mcp/server.ts`, `routes/metrics.ts`, `routes/setup.ts`.

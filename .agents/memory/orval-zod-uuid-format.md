---
name: Orval zod codegen breaks on format uuid/date-time
description: Why `pnpm --filter @workspace/api-spec run codegen` can fail typecheck after adding `format: uuid` to the OpenAPI spec, and the fix.
---

Orval 8.x generates Zod schemas assuming the Zod v4 top-level API (e.g.
`zod.uuid()`), but this workspace's `zod` catalog pin resolves to a 3.25.x
package whose default `zod` import is the v3 tree (only `zod/v4` subpath has
the new top-level validators). Result: `format: uuid` on a string schema in
`lib/api-spec/openapi.yaml` produces `zod.uuid()` in the generated file,
which fails `tsc --build` with `Property 'uuid' does not exist on type ...`.

**Why:** orval's zod client targets zod v4 syntax; this workspace intentionally
pins zod v3.x (other code explicitly imports `zod/v4` where it wants v4
behavior, e.g. `drizzle-zod` schemas) and orval isn't configured to import
from `zod/v4`.

**How to apply:** avoid `format: uuid` (and be alert to other format-derived
top-level validators) in `lib/api-spec/openapi.yaml`; use plain
`type: string` for UUID fields instead. Re-run codegen and
`pnpm run typecheck:libs` after any spec change to catch this early.

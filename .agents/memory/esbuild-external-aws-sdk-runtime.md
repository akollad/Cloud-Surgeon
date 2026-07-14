---
name: esbuild externals need node_modules in the runtime image
description: api-server's esbuild bundle externalizes @aws-sdk/* and other native/optional packages; a dist-only Docker image crashes at boot with ERR_MODULE_NOT_FOUND.
---

`artifacts/api-server/build.mjs` deliberately externalizes a long list of packages
(`@aws-sdk/*`, native modules, etc.) from the esbuild bundle. Any module that statically
imports one of these (e.g. `lib/aws.ts` → `@aws-sdk/client-ecs`/`client-rds`/`client-lambda`/
`client-cloudwatch`, `lib/embeddings.ts` → `@aws-sdk/client-bedrock-runtime`) will crash the
process immediately on startup in a container that only ships `dist/`.

**Why:** esbuild's `external` list exists for packages that don't bundle cleanly (native
bindings, dynamic `require`, etc.), but it means the compiled `.mjs` still contains a bare
`import "@aws-sdk/..."` that Node resolves from `node_modules` at load time — not lazily.

**How to apply:** when building a standalone/production Docker image for this service, copy
`node_modules` (root + `artifacts/api-server/node_modules`) from the build stage into the
final image alongside `dist/` — do not ship a `dist/`-only image. If a new externalized
package gets a static (non-dynamic) import added to the source, this bites again.

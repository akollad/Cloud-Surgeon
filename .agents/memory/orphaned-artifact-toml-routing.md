---
name: Orphaned artifact.toml files still drive proxy routing
description: When a project was imported from another environment, listArtifacts() may show nothing even though the platform's routing proxy still reads .replit-artifact/artifact.toml files on disk.
---

On an imported project, `listArtifacts()` can return empty for directories that still have a real `.replit-artifact/artifact.toml`. That does **not** mean the proxy ignores them — the routing layer reads `artifact.toml` directly off disk. If a workflow's `PORT`/base-path doesn't match what `artifact.toml` declares (`previewPath`, expected port), requests 404 with a page listing the artifact paths the deployment/proxy actually knows about.

**Why:** discovered on Cloud-Surgeon: a dashboard workflow was configured with an arbitrary port/base path (`PORT=5000 BASE_PATH=/`) and rendered fine standalone, but the shared dev domain 404'd and revealed the proxy expected `/dashboard/` — straight from the orphaned `artifact.toml`.

**How to apply:** before configuring a workflow for a directory that already has `.replit-artifact/artifact.toml` (even if `listArtifacts()` doesn't see it), read that file first and match its `previewPath`/port exactly. Treat it as authoritative routing config, not as dead metadata.

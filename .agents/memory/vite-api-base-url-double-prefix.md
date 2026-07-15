---
name: VITE_API_BASE_URL double /api/ prefix
description: Setting VITE_API_BASE_URL to /api causes every API call to become /api/api/... because the generated client already prefixes paths with /api/.
---

## Rule
Leave `VITE_API_BASE_URL` empty (or unset) in all environments for this project.

**Why:** The Orval-generated client in `lib/api-client-react/src/generated/api.ts` hardcodes full paths like `/api/healthz`, `/api/incidents`, etc. `custom-fetch.ts`'s `setBaseUrl()` prepends the base to any path starting with `/`. Setting `VITE_API_BASE_URL=/api` therefore doubles the prefix: `/api/api/healthz` → 404.

**How to apply:** Only set `VITE_API_BASE_URL` when the API is on a completely different origin (cross-origin calls from a mobile app or external client). For same-origin Vite proxy or ALB routing, leave it empty. Check `lib/api-client-react/src/custom-fetch.ts` `setBaseUrl()` and `artifacts/dashboard/src/main.tsx` for the wiring.

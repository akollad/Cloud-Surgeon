---
name: ccloud CLI headless auth in ECS
description: bootstrapCcloudCredentials() écrit le bon format snake_case api_key au démarrage — Layer-1 binary actif en dev et en prod (ECS). L'ancienne note REST-fallback était basée sur le bug camelCase.
---

# ccloud CLI in ECS — état post-fix (juillet 2026)

## Ce qui fonctionne maintenant
`bootstrapCcloudCredentials()` dans `artifacts/api-server/src/index.ts` écrit au démarrage :
- `credentials.json` → `{ "default": { "api_key": "..." } }` (snake_case — clé que ccloud v0.6.12 lit)
- `profiles.json` → org metadata (organizationId, organizationLabel, organizationName, server, userFullName)

Ce format est identique en dev (Replit) et en prod (ECS). Le binaire s'authentifie headlessly sans browser OAuth dans les deux environnements.

**Why the old note was wrong:** La mémoire précédente a été écrite quand `bootstrapCcloudCredentials()` utilisait `apiKey` (camelCase). Le binaire lisait `json:"api_key"` (snake_case) — le champ camelCase était silencieusement ignoré, `whoami` retournait "not logged in", le fallback REST prenait le relais. Fix : une lettre (`api_key` vs `apiKey`).

## Chemins en production (ECS)
- Binaire : `/usr/local/bin/ccloud` (copié par le Dockerfile depuis le stage `ccloud`)
- Config dir : `os.homedir() + "/.config/.cockroachdb/"` (`XDG_CONFIG_HOME` non défini dans le container → fallback homedir)
- `COCKROACH_CLOUD_API_KEY` doit être injecté comme secret ECS

## Dockerfile requirements (toujours valides)
- Base image `node:24-slim` (Debian/glibc) — ccloud est un binaire glibc ; Alpine (musl) incompatible.
- `ca-certificates` + `curl` installés via apt-get — nécessaires pour les appels TLS vers `cockroachlabs.cloud` et le health check ECS.

## Fallback REST (toujours présent)
`callCockroachCloudRestApi()` reste en place comme fallback si le binaire échoue pour une raison inattendue. Chaque réponse inclut `ccloudEquivalent` pour la transparence.

---
name: ccloud CLI headless auth in ECS
description: bootstrapCcloudCredentials() fonctionne en dev et en prod depuis le fix juillet 2026 — deux bugs corrigés (snake_case + import path manquant).
---

# ccloud CLI in ECS — état post-fix (juillet 2026)

## Deux bugs corrigés, dans l'ordre

### Bug 1 — format credentials.json (snake_case)
ccloud v0.6.12 attend `{ "default": { "api_key": "..." } }` (snake_case).
Le code écrivait `apiKey` (camelCase) → silencieusement ignoré → "not logged in".

### Bug 2 — `import path from "node:path"` manquant dans index.ts (le vrai bloquant ECS)
`index.ts` n'importait pas `path`. esbuild bundle les autres fichiers avec `path2`, `path3`, etc.
La variable `path` dans `bootstrapCcloudCredentials` était `undefined` → `ReferenceError` à `path.join(...)`.
Cette erreur était swallowed par `.catch(() => {})` au call site → pas de log, pas de fichiers écrits.

**Pourquoi ça marchait en dev et pas en prod :**
Le filesystem Replit est persistant. Les fichiers credentials écrits manuellement (test ou OAuth session précédente) survivaient aux redémarrages. En prod, le container ECS repart de zéro à chaque déploiement → aucun fichier → "not logged in".

## Séquence de boot correcte (post-fix)
```
[CCLOUD-BOOT] bootstrapCcloudCredentials called
[CCLOUD-BOOT] apiKey present=true len=69
[CCLOUD-BOOT] dir=/root/.config/.cockroachdb        ← $HOME/.config en ECS (pas de XDG_CONFIG_HOME)
[CCLOUD-BOOT] mkdir OK
[CCLOUD-BOOT] credentials.json written
[CCLOUD-BOOT] org=org-3bf3g — writing profiles.json
[CCLOUD-BOOT] profiles.json written
[CCLOUD-BOOT] configuration.json written — bootstrap complete
[BOOT] ccloud: ccloud 0.6.12 | 🟢 authenticated (logged in to "Akollad Groupe" (org-3bf3g) as Ryan Sabowa)
```

## Chemins en production (ECS)
- Binaire : `/usr/local/bin/ccloud` (copié par Dockerfile depuis le stage `ccloud`)
- Config dir : `/root/.config/.cockroachdb/` (`XDG_CONFIG_HOME` non défini → fallback `os.homedir()`)
- `COCKROACH_CLOUD_API_KEY` injecté comme secret ECS depuis Secrets Manager `cloud-surgeon/prod`

## Dockerfile requirements
- Base image `node:24-slim` (Debian/glibc) — ccloud est un binaire glibc ; Alpine (musl) incompatible.
- `ca-certificates` + `curl` installés via apt-get.

## Règle anti-régression
Tout fichier qui appelle `path.join` **doit** avoir `import path from "node:path"` — esbuild ne détecte pas les variables non importées (pas de type-checking). Un `path` non importé devient `undefined` silencieusement dans le bundle.

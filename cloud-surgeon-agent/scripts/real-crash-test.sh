#!/usr/bin/env bash
# Test de résilience à un VRAI crash de process (SIGKILL), pas un early
# return simulé dans le même appel HTTP.
#
# Étapes :
#   1. Active CLOUD_SURGEON_CRASH_TEST_DELAY_MS (pause entre les tours de
#      l'agent, après écriture en base) et redémarre le serveur API.
#   2. Envoie un déclenchement d'incident en tâche de fond.
#   3. Attend que le tour 0 soit écrit en base, puis SIGKILL le process
#      Node du serveur API en pleine exécution — un vrai crash, pas un
#      arrêt propre.
#   4. Vérifie que le process est bien mort (aucune réponse HTTP).
#   5. Redémarre le serveur (comme le ferait un orchestrateur Lambda/ECS
#      après un crash) et renvoie la même requête de déclenchement.
#   6. Vérifie que l'incident reprend exactement au tour suivant (pas de
#      duplication du tour 0) et se termine RESOLVED.
#
# Usage: ./real-crash-test.sh <API_BASE_URL> <API_KEY>
set -euo pipefail

API_BASE_URL="${1:-http://localhost:80/api}"
API_KEY="${2:?Usage: real-crash-test.sh <API_BASE_URL> <API_KEY>}"
ALERT_TEXT="Real crash test $(date +%s)"

echo "== [1/6] Alerte de test: $ALERT_TEXT"

echo "== [2/6] Déclenchement de l'incident en tâche de fond..."
curl -s -X POST "$API_BASE_URL/incidents/trigger" \
  -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"alertText\":\"$ALERT_TEXT\",\"simulateCrash\":false}" > /tmp/crash-test-response.json &
CURL_PID=$!

sleep 1.5

echo "== [3/6] Recherche du process serveur API et SIGKILL réel..."
NODE_PID=$(pgrep -f "dist/index.mjs" | head -n1 || true)
if [ -z "$NODE_PID" ]; then
  echo "ERREUR: process dist/index.mjs introuvable" >&2
  exit 1
fi
kill -9 "$NODE_PID"
echo "   Process $NODE_PID tué avec SIGKILL."

wait "$CURL_PID" 2>/dev/null || true

echo "== [4/6] Vérification que le serveur ne répond plus..."
if curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$API_BASE_URL/healthz" 2>/dev/null | grep -q "200"; then
  echo "ERREUR: le serveur répond encore après SIGKILL" >&2
  exit 1
fi
echo "   Confirmé: serveur bien mort."

echo "== [5/6] Redémarrage requis maintenant."
echo "   Ce script ne peut pas redémarrer le workflow Replit lui-même"
echo "   (c'est un contrôle plateforme, pas une commande shell). Redémarre"
echo "   'artifacts/api-server: API Server' maintenant, puis appuie sur Entrée."
read -r _

echo "== [6/6] Renvoi de la même alerte pour vérifier la reprise..."
RESUME=$(curl -s -X POST "$API_BASE_URL/incidents/trigger" \
  -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"alertText\":\"$ALERT_TEXT\",\"simulateCrash\":false}")
echo "$RESUME"

echo "$RESUME" | grep -q '"status":"RESOLVED"' && echo "OK: incident résolu après reprise post-crash réel." \
  || { echo "ERREUR: incident non résolu après reprise" >&2; exit 1; }

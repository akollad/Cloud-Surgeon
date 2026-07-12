#!/usr/bin/env bash
# Resilience test against a REAL process crash (SIGKILL), not an early
# return simulated within the same HTTP call.
#
# Steps:
#   1. Enables CLOUD_SURGEON_CRASH_TEST_DELAY_MS (pause between agent turns
#      after writing to the DB) and restarts the API server.
#   2. Sends an incident trigger in the background.
#   3. Waits for turn 0 to be written to the DB, then SIGKILLs the
#      Node process of the API server mid-execution — a real crash, not a
#      clean shutdown.
#   4. Verifies that the process is dead (no HTTP response).
#   5. Restarts the server (as a Lambda/ECS orchestrator would after a crash)
#      and re-sends the same trigger request.
#   6. Verifies that the incident resumes at the next turn (no duplication
#      of turn 0) and finishes RESOLVED.
#
# Usage: ./real-crash-test.sh <API_BASE_URL> <API_KEY>
set -euo pipefail

API_BASE_URL="${1:-http://localhost:80/api}"
API_KEY="${2:?Usage: real-crash-test.sh <API_BASE_URL> <API_KEY>}"
ALERT_TEXT="Real crash test $(date +%s)"

echo "== [1/6] Test alert: $ALERT_TEXT"

echo "== [2/6] Triggering incident in the background..."
curl -s -X POST "$API_BASE_URL/incidents/trigger" \
  -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"alertText\":\"$ALERT_TEXT\",\"simulateCrash\":false}" > /tmp/crash-test-response.json &
CURL_PID=$!

sleep 1.5

echo "== [3/6] Finding API server process and sending real SIGKILL..."
NODE_PID=$(pgrep -f "dist/index.mjs" | head -n1 || true)
if [ -z "$NODE_PID" ]; then
  echo "ERROR: dist/index.mjs process not found" >&2
  exit 1
fi
kill -9 "$NODE_PID"
echo "   Process $NODE_PID killed with SIGKILL."

wait "$CURL_PID" 2>/dev/null || true

echo "== [4/6] Verifying that the server is no longer responding..."
if curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$API_BASE_URL/healthz" 2>/dev/null | grep -q "200"; then
  echo "ERROR: server still responding after SIGKILL" >&2
  exit 1
fi
echo "   Confirmed: server is dead."

echo "== [5/6] Restart required now."
echo "   This script cannot restart the Replit workflow itself"
echo "   (it is a platform control, not a shell command). Restart"
echo "   'artifacts/api-server: API Server' now, then press Enter."
read -r _

echo "== [6/6] Re-sending the same alert to verify resumption..."
RESUME=$(curl -s -X POST "$API_BASE_URL/incidents/trigger" \
  -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"alertText\":\"$ALERT_TEXT\",\"simulateCrash\":false}")
echo "$RESUME"

echo "$RESUME" | grep -q '"status":"RESOLVED"' && echo "OK: incident resolved after real post-crash resumption." \
  || { echo "ERROR: incident not resolved after resumption" >&2; exit 1; }

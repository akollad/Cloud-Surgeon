"""
Cloud-Surgeon — Dashboard de simulation (Streamlit)

Interface interactive pour déclencher des "pannes" simulées et regarder
l'agent Cloud-Surgeon les diagnostiquer et les réparer, en direct.

Architecture (voir le document d'architecture du projet) :

    Frontend (ce fichier) --HTTP (API Gateway)--> Backend (Lambda) --> Bedrock
                                                                    --> CockroachDB

Dans ce Repl, le rôle de "API Gateway + Lambda" est joué par le service API
Express du monorepo (`artifacts/api-server`, routes `/api/incidents/*` et
`/api/logs`, implémentation dans `artifacts/api-server/src/lib/cloud-surgeon.ts`) :

1. Ce dashboard clique "Déclencher l'agent" → envoie une requête HTTP POST à
   `/api/incidents/trigger`.
2. Le backend fait le travail : il "réfléchit" (raisonnement Claude simulé,
   en l'absence de credentials AWS Bedrock dans ce Repl), écrit et lit l'état
   dans la base (CockroachDB Serverless réel — même schéma, mêmes requêtes
   `<=>` de similarité cosinus que la production AWS).
3. Le backend répond avec l'incident mis à jour.
4. Ce dashboard rafraîchit ses tableaux en interrogeant régulièrement
   `/api/incidents` et `/api/logs`.

Le vrai déploiement AWS (`backend/lambda_function.py`, Bedrock + CockroachDB
Serverless) est décrit dans le README à la racine du projet ; ce dashboard
est un stand-in fonctionnel côté Replit pour la démo/vidéo Devpost.
"""

from __future__ import annotations

import os

import requests
import streamlit as st

# ----------------------------------------------------------------------------
# Le service API du monorepo (Express) joue le rôle d'API Gateway + Lambda.
# Il est routé par le proxy partagé du Repl sur le chemin /api. Depuis ce
# process Python (côté serveur, pas navigateur), on l'atteint directement via
# le proxy local sur le port 80 — la même route que curl utiliserait.
# ----------------------------------------------------------------------------
API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:80/api")

# Clé API partagée avec le backend (voir artifacts/api-server/src/middleware/apiKeyAuth.ts).
# /healthz reste public ; toutes les routes /incidents et /logs l'exigent.
_API_KEY = os.environ.get("CLOUD_SURGEON_API_KEY", "")
_AUTH_HEADERS = {"x-api-key": _API_KEY} if _API_KEY else {}


def api_post(path: str, json: dict) -> dict | None:
    try:
        resp = requests.post(f"{API_BASE_URL}{path}", json=json, headers=_AUTH_HEADERS, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:  # noqa: BLE001
        st.session_state["_api_error"] = str(exc)
        return None


def api_get(path: str, params: dict | None = None) -> list | dict | None:
    try:
        resp = requests.get(f"{API_BASE_URL}{path}", params=params, headers=_AUTH_HEADERS, timeout=15)
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:  # noqa: BLE001
        st.session_state["_api_error"] = str(exc)
        return None


def trigger_agent(alert_text: str, simulate_crash: bool) -> dict | None:
    return api_post("/incidents/trigger", {"alertText": alert_text, "simulateCrash": simulate_crash})


def fetch_incidents() -> list:
    return api_get("/incidents") or []


def fetch_logs() -> list:
    return api_get("/logs") or []


# ----------------------------------------------------------------------------
# Scénarios d'incidents prédéfinis
# Chaque scénario a un message d'erreur réaliste et une stratégie prédéfinie
# (strategy_name) qui alimentera la mémoire vectorielle de l'agent.
# ----------------------------------------------------------------------------
PRESET_SCENARIOS = {
    # ── Scénarios originaux ─────────────────────────────────────────────────
    "Pic d'erreurs 5xx sur le service de paiement (ECS)": (
        "ECS service 'checkout' unhealthy: 5xx spike on /pay endpoint, latency p99 > 4s",
        "ecs_service_restart",
    ),
    "Saturation CPU sur la base primaire (RDS)": (
        "RDS primary instance 'orders-db' CPU utilization at 98% for 10 minutes",
        "rds_cpu_throttle",
    ),
    "Throttling Lambda en cascade": (
        "Lambda function 'order-processor' throttled: ConcurrentExecutions limit reached",
        "lambda_concurrency_scale",
    ),
    "Disque plein sur un nœud de calcul": (
        "EC2 instance 'worker-03' disk usage at 95%, risk of service crash",
        "disk_cleanup",
    ),
    # ── Nouveaux scénarios — Semaine 1 ──────────────────────────────────────
    "Fuite mémoire JVM (service de recommandations)": (
        "JVM heap exhaustion on 'recommendation-service' pod: GC overhead limit exceeded, "
        "OOMKiller triggered, pod restarting every 3 minutes",
        "jvm_heap_restart",
    ),
    "Pool de connexions DB saturé (Postgres RDS)": (
        "RDS 'catalog-db' max_connections reached (500/500): new connections refused, "
        "pg_stat_activity shows 320 idle-in-transaction sessions older than 30s",
        "db_connection_pool_reset",
    ),
    "Latence cross-région > SLA (API Gateway us-east-1 → eu-west-1)": (
        "API Gateway p99 latency degraded: us-east-1 → eu-west-1 cross-region calls "
        "averaging 2800ms (SLA: 500ms), likely BGP route flap or transit gateway saturation",
        "network_route_failover",
    ),
    "Credential AWS expiré (accès S3 depuis ECS)": (
        "ECS task 'data-export' failing: AccessDeniedException on s3:PutObject to "
        "s3://prod-exports — IAM role credential rotation missed, token expired 2h ago",
        "iam_credential_rotation",
    ),
    "Dépendance externe down (Stripe API)": (
        "Payment gateway degraded: Stripe API returning 503 on /v1/charges for 8 minutes, "
        "checkout conversion rate dropped from 94% to 12%, revenue impact ~$4200/min",
        "external_dependency_circuit_break",
    ),
}


# ----------------------------------------------------------------------------
# UI Streamlit
# ----------------------------------------------------------------------------
st.set_page_config(page_title="Cloud-Surgeon — Dashboard", layout="wide")

st.title("☁️🔪 Cloud-Surgeon — Dashboard de simulation")
st.caption(
    "Déclenche une panne, regarde l'agent la diagnostiquer et la réparer via une vraie requête HTTP "
    "vers le backend (rôle d'API Gateway + Lambda), et prouve que la base de données conserve son état "
    "même si l'agent est interrompu en plein vol."
)

st.session_state.pop("_api_error", None)
health = api_get("/healthz")
if health and health.get("status") == "ok":
    st.success(f"✅ Connecté au backend ({API_BASE_URL}) — l'état des incidents est réellement persisté en base CockroachDB.")
else:
    reason = st.session_state.get("_api_error", "réponse inattendue du backend")
    st.error(f"❌ Impossible de joindre le backend sur {API_BASE_URL} : {reason}")

with st.sidebar:
    st.header("🚨 Déclencher une panne")

    scenario_groups = {
        "Scénarios originaux": [
            "Pic d'erreurs 5xx sur le service de paiement (ECS)",
            "Saturation CPU sur la base primaire (RDS)",
            "Throttling Lambda en cascade",
            "Disque plein sur un nœud de calcul",
        ],
        "Nouveaux scénarios (S1)": [
            "Fuite mémoire JVM (service de recommandations)",
            "Pool de connexions DB saturé (Postgres RDS)",
            "Latence cross-région > SLA (API Gateway us-east-1 → eu-west-1)",
            "Credential AWS expiré (accès S3 depuis ECS)",
            "Dépendance externe down (Stripe API)",
        ],
    }

    all_labels = [label for labels in scenario_groups.values() for label in labels]
    scenario_label = st.selectbox("Scénario prédéfini", all_labels)

    # Afficher la stratégie prédéfinie pour ce scénario
    selected_alert_text, selected_strategy = PRESET_SCENARIOS[scenario_label]
    st.caption(f"Stratégie : `{selected_strategy}`")

    custom_text = st.text_area(
        "Ou décris ta propre alerte",
        value="",
        placeholder="Ex: latence réseau anormale sur le VPC prod",
    )
    alert_text = custom_text.strip() or selected_alert_text

    crash_choice = st.selectbox(
        "Simuler un crash de la Lambda",
        ["Aucun (exécution normale)", "Après le diagnostic (tour 1)"],
        help="Démontre que la base conserve l'état exact même si l'agent (le backend) est interrompu avant la fin.",
    )
    simulate_crash = crash_choice.startswith("Après")

    trigger = st.button("⚡ Déclencher l'agent", type="primary", use_container_width=True)

    st.divider()
    st.subheader("🌐 Webhook CloudWatch")
    st.caption(
        "En production, une alarme CloudWatch → SNS appelle `POST /api/webhook/cloudwatch`. "
        "Teste-le manuellement ci-dessous."
    )
    wh_alarm_name = st.text_input("AlarmName", value="checkout-5xx-spike")
    wh_reason = st.text_input("NewStateReason", value="Threshold Crossed: 3 datapoints > 10.")
    if st.button("📡 Simuler un webhook CloudWatch", use_container_width=True):
        wh_payload = {
            "AlarmName": wh_alarm_name,
            "NewStateValue": "ALARM",
            "NewStateReason": wh_reason,
            "Region": "us-east-1",
        }
        result = api_post("/webhook/cloudwatch", wh_payload)
        if result:
            st.success(f"Webhook accepté — incident `{result.get('incidentId', '')[:8]}` ({result.get('status')})")
        else:
            st.error(f"Erreur : {st.session_state.get('_api_error')}")

tab_live, tab_incidents, tab_logs = st.tabs(["🔴 Diagnostic en direct", "📋 Incidents", "📜 Journal d'exécution"])

with tab_live:
    if trigger:
        with st.spinner("Requête HTTP envoyée au backend (API Gateway → Lambda)…"):
            incident = trigger_agent(alert_text, simulate_crash)

        if incident is None:
            st.error(f"La requête vers le backend a échoué : {st.session_state.get('_api_error')}")
        else:
            fingerprint_short = incident["alertFingerprint"][:12]
            turns = incident["contextJson"].get("turns", [])

            st.subheader(f"Incident `{incident['incidentId'][:8]}` (empreinte `{fingerprint_short}…`)")
            st.write(f"**Statut :** `{incident['status']}` — **Étape :** `{incident['currentStep']}`")

            if len(turns) > 0 and incident["status"] not in ("RESOLVED", "FAILED"):
                st.warning(
                    "💥 L'agent s'est arrêté avant la fin (crash simulé du backend). L'état a déjà été "
                    "persisté en base avant ce point — clique de nouveau sur « Déclencher l'agent » avec "
                    "la même alerte pour prouver la reprise sans perte de contexte."
                )
            elif incident["status"] in ("RESOLVED", "FAILED"):
                st.success(incident["contextJson"].get("finalResponse") or f"Incident {incident['status']}.")

            for turn in turns:
                thought_source = turn.get("thoughtSource", "simulated")
                source_badge = "🧠 Bedrock" if thought_source == "bedrock" else "🤖 Simulé"
                with st.expander(
                    f"Tour {turn['turn'] + 1} — {turn['toolName']} ({source_badge})",
                    expanded=True,
                ):
                    st.write(f"**Pensée de l'agent ({source_badge}) :** {turn['thought']}")
                    st.write(f"**Appel d'outil :** `{turn['toolName']}({turn['toolInput']})`")
                    st.write(f"**Résultat :** `{turn['toolOutput']}`")
    else:
        st.caption("Choisis un scénario dans la barre latérale et clique sur « ⚡ Déclencher l'agent ».")

with tab_incidents:
    col1, col2 = st.columns([1, 4])
    with col1:
        if st.button("🔄 Rafraîchir"):
            st.rerun()
    incidents = fetch_incidents()
    if not incidents:
        st.caption("Aucun incident pour l'instant.")
    else:
        st.dataframe(
            [
                {
                    "Incident": i["incidentId"][:8],
                    "Empreinte": i["alertFingerprint"][:12],
                    "Statut": i["status"],
                    "Étape": i["currentStep"],
                    "Mis à jour": i["updatedAt"],
                }
                for i in incidents
            ],
            use_container_width=True,
            hide_index=True,
        )

with tab_logs:
    col1, col2 = st.columns([1, 4])
    with col1:
        if st.button("🔄 Rafraîchir", key="refresh_logs"):
            st.rerun()
    logs = fetch_logs()
    if not logs:
        st.caption("Aucune action journalisée pour l'instant.")
    else:
        st.dataframe(
            [
                {
                    "Incident": l["incidentId"][:8],
                    "Action": l["actionTaken"],
                    "Résultat": l["result"],
                    "Horodatage": l["createdAt"],
                }
                for l in logs
            ],
            use_container_width=True,
            hide_index=True,
        )

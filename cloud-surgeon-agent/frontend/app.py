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
   dans la base (CockroachDB en production, Postgres+pgvector dans ce Repl de
   développement — même schéma, mêmes requêtes `<=>` de similarité cosinus).
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


def api_post(path: str, json: dict) -> dict | None:
    try:
        resp = requests.post(f"{API_BASE_URL}{path}", json=json, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:  # noqa: BLE001
        st.session_state["_api_error"] = str(exc)
        return None


def api_get(path: str, params: dict | None = None) -> list | dict | None:
    try:
        resp = requests.get(f"{API_BASE_URL}{path}", params=params, timeout=15)
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
# UI Streamlit
# ----------------------------------------------------------------------------
st.set_page_config(page_title="Cloud-Surgeon — Dashboard", layout="wide")

st.title("Cloud-Surgeon — Dashboard de simulation")
st.caption(
    "Déclenche une panne, regarde l'agent la diagnostiquer et la réparer via une vraie requête HTTP "
    "vers le backend (rôle d'API Gateway + Lambda), et prouve que la base de données conserve son état "
    "même si l'agent est interrompu en plein vol."
)

st.session_state.pop("_api_error", None)
health = api_get("/healthz")
if health and health.get("status") == "ok":
    st.success(f"Connecté au backend ({API_BASE_URL}) — l'état des incidents est réellement persisté en base.")
else:
    reason = st.session_state.get("_api_error", "réponse inattendue du backend")
    st.error(f"Impossible de joindre le backend sur {API_BASE_URL} : {reason}")

PRESET_SCENARIOS = {
    "Pic d'erreurs 5xx sur le service de paiement (ECS)": "ECS service 'checkout' unhealthy: 5xx spike on /pay endpoint, latency p99 > 4s",
    "Saturation CPU sur la base primaire (RDS)": "RDS primary instance 'orders-db' CPU utilization at 98% for 10 minutes",
    "Throttling Lambda en cascade": "Lambda function 'order-processor' throttled: ConcurrentExecutions limit reached",
    "Disque plein sur un nœud de calcul": "EC2 instance 'worker-03' disk usage at 95%, risk of service crash",
}

with st.sidebar:
    st.header("Déclencher une panne")
    scenario_label = st.selectbox("Scénario prédéfini", list(PRESET_SCENARIOS.keys()))
    custom_text = st.text_area("Ou décris ta propre alerte", value="", placeholder="Ex: latence réseau anormale sur le VPC prod")
    alert_text = custom_text.strip() or PRESET_SCENARIOS[scenario_label]

    crash_choice = st.selectbox(
        "Simuler un crash de la Lambda",
        ["Aucun (exécution normale)", "Après le diagnostic (tour 1)"],
        help="Démontre que la base conserve l'état exact même si l'agent (le backend) est interrompu avant la fin.",
    )
    simulate_crash = crash_choice.startswith("Après")

    trigger = st.button("Déclencher l'agent", type="primary", use_container_width=True)

tab_live, tab_incidents, tab_logs = st.tabs(["Diagnostic en direct", "Incidents", "Journal d'exécution"])

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
                with st.expander(f"Tour {turn['turn'] + 1} — {turn['toolName']}", expanded=True):
                    st.write(f"**Pensée de l'agent :** {turn['thought']}")
                    st.write(f"**Appel d'outil :** `{turn['toolName']}({turn['toolInput']})`")
                    st.write(f"**Résultat :** `{turn['toolOutput']}`")
    else:
        st.caption("Choisis un scénario dans la barre latérale et clique sur « Déclencher l'agent ».")

with tab_incidents:
    if st.button("Rafraîchir"):
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
    if st.button("Rafraîchir ", key="refresh_logs"):
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

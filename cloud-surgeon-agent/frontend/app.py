"""
Cloud-Surgeon — Dashboard de simulation (Streamlit)

Interface interactive pour déclencher des "pannes" simulées et regarder
l'agent Cloud-Surgeon les diagnostiquer et les réparer, en direct.

Deux modes, sélectionnés automatiquement :

1. Mode CockroachDB (si la variable d'environnement COCKROACHDB_URL est
   définie) : l'état des incidents, le journal d'exécution et la mémoire
   vectorielle RAG sont RÉELLEMENT lus/écrits dans CockroachDB, exactement
   comme le ferait la Lambda de production (mêmes tables, même schéma,
   mêmes requêtes de similarité cosinus `<=>`). Cela permet de démontrer en
   vidéo que CockroachDB survit bien à une "coupure" de l'agent.

2. Mode simulation (si aucune base n'est connectée) : tout l'état vit dans
   `st.session_state`, pour pouvoir enregistrer une démo immédiatement sans
   configurer d'infrastructure.

Dans les deux modes, le raisonnement de Claude 3.5 Sonnet et les outils
(`execute_ccloud_command`, `aws_repair_service`) sont simulés par un petit
moteur déterministe (`simulate_agent_turn`) afin que la démo fonctionne sans
clés AWS Bedrock. En production, ce rôle est tenu par `run_agent_loop` dans
`backend/lambda_function.py`, qui appelle réellement Bedrock.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone

import streamlit as st

try:
    import psycopg2
    import psycopg2.extras
except ImportError:  # pragma: no cover - psycopg2 optional in pure simulation mode
    psycopg2 = None

# ----------------------------------------------------------------------------
# Connexion (mode CockroachDB si disponible)
# ----------------------------------------------------------------------------
COCKROACHDB_URL = os.environ.get("COCKROACHDB_URL")


@st.cache_resource(show_spinner=False)
def get_connection():
    """Ouvre (et met en cache pour la session Streamlit) une connexion CockroachDB."""
    if not COCKROACHDB_URL or psycopg2 is None:
        return None
    try:
        conn = psycopg2.connect(
            COCKROACHDB_URL,
            cursor_factory=psycopg2.extras.RealDictCursor,
            connect_timeout=10,
            sslmode="require",
        )
        conn.autocommit = False
        return conn
    except Exception as exc:  # noqa: BLE001
        st.session_state["_db_error"] = str(exc)
        return None


CONN = get_connection()
DB_MODE = CONN is not None


def _fingerprint(alert_text: str) -> str:
    return hashlib.sha256(alert_text.strip().encode("utf-8")).hexdigest()


def _pseudo_embedding(text: str) -> list[float]:
    """
    Vecteur pseudo-aléatoire déterministe (1024 dims) dérivé d'un hash du
    texte. Tient lieu de remplaçant à Amazon Titan Text Embeddings V2 pour
    la démo, sans nécessiter de credentials AWS. En production, cette
    fonction est `get_embedding()` dans `backend/lambda_function.py`, qui
    appelle réellement Bedrock.
    """
    seed = int(hashlib.sha256(text.strip().encode("utf-8")).hexdigest(), 16)
    vec = []
    x = seed
    for _ in range(1024):
        x = (1103515245 * x + 12345) & 0x7FFFFFFF
        vec.append((x / 0x7FFFFFFF) * 2 - 1)
    return vec


def _cosine_distance(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 1.0
    cosine_sim = dot / (norm_a * norm_b)
    return 1 - cosine_sim


def _vector_literal(embedding: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in embedding) + "]"


# ----------------------------------------------------------------------------
# Persistance : incident_state / incident_vectors / execution_logs
# Mêmes tables et mêmes requêtes que backend/lambda_function.py, mais
# rejouées ici depuis Streamlit (mode CockroachDB) ou simulées en mémoire.
# ----------------------------------------------------------------------------
def _init_session_store() -> None:
    if "sim_incidents" not in st.session_state:
        st.session_state.sim_incidents = {}  # fingerprint -> incident dict
    if "sim_vectors" not in st.session_state:
        st.session_state.sim_vectors = []  # list of {"text":..., "embedding":...}
    if "sim_logs" not in st.session_state:
        st.session_state.sim_logs = []  # list of log rows


_init_session_store()


def get_or_create_incident(alert_text: str) -> dict:
    fingerprint = _fingerprint(alert_text)

    if DB_MODE:
        with CONN.cursor() as cur:
            cur.execute(
                """
                INSERT INTO incident_state (alert_fingerprint, status, current_step, context_json)
                VALUES (%s, 'TRIGGERED', 'INIT', %s::jsonb)
                ON CONFLICT (alert_fingerprint) DO NOTHING
                RETURNING incident_id, alert_fingerprint, status, current_step, context_json, updated_at;
                """,
                (fingerprint, json.dumps({"alert_text": alert_text, "turns": []})),
            )
            row = cur.fetchone()
            if row is None:
                cur.execute(
                    "SELECT incident_id, alert_fingerprint, status, current_step, context_json, updated_at "
                    "FROM incident_state WHERE alert_fingerprint = %s;",
                    (fingerprint,),
                )
                row = cur.fetchone()
            CONN.commit()
            return dict(row)

    existing = st.session_state.sim_incidents.get(fingerprint)
    if existing:
        return existing

    incident = {
        "incident_id": str(uuid.uuid4()),
        "alert_fingerprint": fingerprint,
        "status": "TRIGGERED",
        "current_step": "INIT",
        "context_json": {"alert_text": alert_text, "turns": []},
        "updated_at": datetime.now(timezone.utc),
    }
    st.session_state.sim_incidents[fingerprint] = incident
    return incident


def persist_incident_state(incident: dict, status: str, current_step: str, context: dict) -> None:
    incident["status"] = status
    incident["current_step"] = current_step
    incident["context_json"] = context
    incident["updated_at"] = datetime.now(timezone.utc)

    if DB_MODE:
        with CONN.cursor() as cur:
            cur.execute(
                """
                UPDATE incident_state
                SET status = %s, current_step = %s, context_json = %s::jsonb, updated_at = now()
                WHERE incident_id = %s;
                """,
                (status, current_step, json.dumps(context), incident["incident_id"]),
            )
            CONN.commit()
    else:
        st.session_state.sim_incidents[incident["alert_fingerprint"]] = incident


def log_execution(incident_id: str, action_taken: str, result: str) -> None:
    row = {
        "log_id": str(uuid.uuid4()),
        "incident_id": incident_id,
        "action_taken": action_taken,
        "result": result,
        "created_at": datetime.now(timezone.utc),
    }
    if DB_MODE:
        with CONN.cursor() as cur:
            cur.execute(
                "INSERT INTO execution_logs (incident_id, action_taken, result) VALUES (%s, %s, %s);",
                (incident_id, action_taken, result),
            )
            CONN.commit()
    else:
        st.session_state.sim_logs.append(row)


def find_similar_incident(embedding: list[float]) -> dict | None:
    if DB_MODE:
        with CONN.cursor() as cur:
            cur.execute(
                """
                SELECT error_message_text, embedding <=> %s::vector AS distance
                FROM incident_vectors
                ORDER BY embedding <=> %s::vector
                LIMIT 1;
                """,
                (_vector_literal(embedding), _vector_literal(embedding)),
            )
            row = cur.fetchone()
            return dict(row) if row else None

    best = None
    for entry in st.session_state.sim_vectors:
        distance = _cosine_distance(embedding, entry["embedding"])
        if best is None or distance < best["distance"]:
            best = {"error_message_text": entry["text"], "distance": distance}
    return best


def index_resolved_incident(error_message_text: str, embedding: list[float]) -> None:
    if DB_MODE:
        with CONN.cursor() as cur:
            cur.execute(
                "INSERT INTO incident_vectors (error_message_text, embedding) VALUES (%s, %s::vector);",
                (error_message_text, _vector_literal(embedding)),
            )
            CONN.commit()
    else:
        st.session_state.sim_vectors.append({"text": error_message_text, "embedding": embedding})


def fetch_all_incidents() -> list[dict]:
    if DB_MODE:
        with CONN.cursor() as cur:
            cur.execute(
                "SELECT incident_id, alert_fingerprint, status, current_step, updated_at "
                "FROM incident_state ORDER BY updated_at DESC LIMIT 50;"
            )
            return [dict(r) for r in cur.fetchall()]
    return sorted(
        st.session_state.sim_incidents.values(), key=lambda i: i["updated_at"], reverse=True
    )


def fetch_all_logs() -> list[dict]:
    if DB_MODE:
        with CONN.cursor() as cur:
            cur.execute(
                "SELECT log_id, incident_id, action_taken, result, created_at "
                "FROM execution_logs ORDER BY created_at DESC LIMIT 100;"
            )
            return [dict(r) for r in cur.fetchall()]
    return sorted(st.session_state.sim_logs, key=lambda r: r["created_at"], reverse=True)


# ----------------------------------------------------------------------------
# Simulation du raisonnement Claude 3.5 Sonnet + tool calling
# (remplace `run_agent_loop` de backend/lambda_function.py pour la démo)
# ----------------------------------------------------------------------------
SCRIPT = [
    {
        "thought": "Je détecte une anomalie d'infrastructure. Avant toute action corrective, "
        "je vérifie l'état réel du composant concerné via la CLI ccloud.",
        "tool_name": "execute_ccloud_command",
        "tool_input": lambda alert: {"command_json": json.dumps({"action": "cluster:status", "target": alert[:40]})},
        "status_after": "DIAGNOSING",
    },
    {
        "thought": "Le diagnostic confirme la dégradation. Je déclenche une action de "
        "réparation ciblée sur le service AWS concerné.",
        "tool_name": "aws_repair_service",
        "tool_input": lambda alert: {"service_name": "auto-detected-service", "action": "restart"},
        "status_after": "REPAIRING",
    },
]


def simulate_tool_call(tool_name: str, tool_input: dict) -> dict:
    """Reproduit fidèlement la sortie simulée des outils du backend Lambda."""
    if tool_name == "execute_ccloud_command":
        action = json.loads(tool_input["command_json"]).get("action", "unknown")
        return {"success": True, "action": action, "output": f"[SIMULATION] Commande ccloud '{action}' exécutée avec succès sur le cluster."}
    if tool_name == "aws_repair_service":
        return {
            "success": True,
            "service_name": tool_input["service_name"],
            "action": tool_input["action"],
            "output": f"[SIMULATION] Action '{tool_input['action']}' appliquée avec succès au service AWS '{tool_input['service_name']}'.",
        }
    return {"success": False, "error": f"Outil inconnu: {tool_name}"}


def run_simulated_agent(incident: dict, alert_text: str, start_turn: int, crash_after: int | None):
    """
    Rejoue la boucle d'agent à partir de `start_turn` (résilience : si on
    reprend un incident déjà entamé, on ne rejoue pas les tours déjà
    persistés). S'arrête prématurément si `crash_after` est atteint, pour
    simuler une Lambda tuée en plein vol.
    """
    context = incident["context_json"]
    context.setdefault("turns", [])

    for turn_index in range(start_turn, len(SCRIPT)):
        step = SCRIPT[turn_index]
        tool_input = step["tool_input"](alert_text)

        with st.status(f"Tour {turn_index + 1} — {step['tool_name']}", expanded=True) as status_box:
            st.write(f"**Pensée de l'agent :** {step['thought']}")
            time.sleep(0.4)
            st.write(f"**Appel d'outil :** `{step['tool_name']}({json.dumps(tool_input)})`")
            tool_output = simulate_tool_call(step["tool_name"], tool_input)
            time.sleep(0.4)
            st.write(f"**Résultat :** `{json.dumps(tool_output)}`")
            status_box.update(label=f"Tour {turn_index + 1} — {step['tool_name']} (terminé)", state="complete")

        log_execution(incident["incident_id"], f"{step['tool_name']}({json.dumps(tool_input)})", json.dumps(tool_output))

        context["turns"].append(
            {
                "turn": turn_index,
                "thought": step["thought"],
                "tool_name": step["tool_name"],
                "tool_input": tool_input,
                "tool_output": tool_output,
            }
        )

        # Écriture immédiate — c'est le point critique de résilience.
        persist_incident_state(incident, step["status_after"], f"AGENT_TURN_{turn_index}", context)

        if crash_after is not None and turn_index == crash_after:
            st.error(
                f"💥 Crash simulé de la Lambda juste après le tour {turn_index + 1}. "
                "L'état a déjà été persisté dans CockroachDB avant ce point — "
                "relance l'agent ci-dessous pour prouver la reprise sans perte de contexte."
            )
            return

    # Réponse finale
    final_text = (
        "RESOLVED: Le service a été redémarré avec succès et les métriques sont revenues à la normale."
    )
    context["final_response"] = final_text
    persist_incident_state(incident, "RESOLVED", "FINALIZED", context)

    st.success(final_text)

    embedding = _pseudo_embedding(alert_text)
    index_resolved_incident(alert_text, embedding)


# ----------------------------------------------------------------------------
# UI Streamlit
# ----------------------------------------------------------------------------
st.set_page_config(page_title="Cloud-Surgeon — Dashboard", layout="wide")

st.title("Cloud-Surgeon — Dashboard de simulation")
st.caption(
    "Déclenche une panne, regarde l'agent la diagnostiquer et la réparer, "
    "et prouve que CockroachDB conserve son état même si l'agent est interrompu en plein vol."
)

if DB_MODE:
    st.success("Connecté à CockroachDB — l'état des incidents et la mémoire RAG sont réellement persistés.")
else:
    reason = st.session_state.get("_db_error")
    msg = "Mode simulation (aucune base CockroachDB connectée) — tout l'état vit dans cette session."
    if reason:
        msg += f" Détail : {reason}"
    st.warning(msg)

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
        help="Démontre que CockroachDB conserve l'état exact même si l'agent est interrompu avant la fin.",
    )
    crash_after = 0 if crash_choice.startswith("Après") else None

    trigger = st.button("Déclencher l'agent", type="primary", use_container_width=True)
    st.divider()
    if st.button("Réinitialiser la démo (session locale)", use_container_width=True):
        st.session_state.sim_incidents = {}
        st.session_state.sim_vectors = []
        st.session_state.sim_logs = []
        st.rerun()

tab_live, tab_incidents, tab_logs = st.tabs(["Diagnostic en direct", "Incidents", "Journal d'exécution"])

with tab_live:
    if trigger:
        incident = get_or_create_incident(alert_text)
        fingerprint_short = incident["alert_fingerprint"][:12]

        already_done = incident["status"] in ("RESOLVED", "FAILED")
        already_started = len(incident["context_json"].get("turns", [])) > 0

        st.subheader(f"Incident `{incident['incident_id'][:8]}` (empreinte `{fingerprint_short}…`)")

        if already_started or already_done:
            st.info(
                f"Incident déjà connu (même empreinte d'alerte) — statut actuel : **{incident['status']}**. "
                f"L'agent reprend à partir de l'état persisté au lieu de repartir de zéro."
            )

        if already_done:
            st.write(f"Cet incident est déjà **{incident['status']}**. Aucune nouvelle action nécessaire.")
        else:
            embedding = _pseudo_embedding(alert_text)
            similar = find_similar_incident(embedding)
            if similar:
                st.info(
                    f"Incident historique similaire trouvé (distance cosinus = {similar['distance']:.4f}) : "
                    f"« {similar['error_message_text']} »"
                )
            else:
                st.caption("Aucun incident historique similaire trouvé — première occurrence de ce type de panne.")

            start_turn = len(incident["context_json"].get("turns", []))
            run_simulated_agent(incident, alert_text, start_turn, crash_after)
    else:
        st.caption("Choisis un scénario dans la barre latérale et clique sur « Déclencher l'agent ».")

with tab_incidents:
    incidents = fetch_all_incidents()
    if not incidents:
        st.caption("Aucun incident pour l'instant.")
    else:
        st.dataframe(
            [
                {
                    "Incident": i["incident_id"][:8],
                    "Empreinte": i["alert_fingerprint"][:12],
                    "Statut": i["status"],
                    "Étape": i["current_step"],
                    "Mis à jour": i["updated_at"],
                }
                for i in incidents
            ],
            use_container_width=True,
            hide_index=True,
        )

with tab_logs:
    logs = fetch_all_logs()
    if not logs:
        st.caption("Aucune action journalisée pour l'instant.")
    else:
        st.dataframe(
            [
                {
                    "Incident": l["incident_id"][:8],
                    "Action": l["action_taken"],
                    "Résultat": l["result"],
                    "Horodatage": l["created_at"],
                }
                for l in logs
            ],
            use_container_width=True,
            hide_index=True,
        )

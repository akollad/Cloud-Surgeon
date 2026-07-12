"""
Cloud-Surgeon — Dashboard de simulation (Streamlit)

Architecture à 3 couches :
  Couche 1 — Mémoire causale et évaluée (RAG vectoriel + win-rate par stratégie)
  Couche 2 — La mémoire décide (routage AUTONOMOUS / PENDING_APPROVAL / EXPLORATORY)
  Couche 3 — Coordination multi-agents via transactions sérialisables CockroachDB
"""

from __future__ import annotations

import os
import time

import requests
import streamlit as st

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:80/api")
_API_KEY = os.environ.get("CLOUD_SURGEON_API_KEY", "")
_AUTH_HEADERS = {"x-api-key": _API_KEY} if _API_KEY else {}


def api_post(path: str, json: dict) -> dict | None:
    try:
        resp = requests.post(
            f"{API_BASE_URL}{path}", json=json, headers=_AUTH_HEADERS, timeout=30
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:
        st.session_state["_api_error"] = str(exc)
        return None


def api_get(path: str, params: dict | None = None) -> list | dict | None:
    try:
        resp = requests.get(
            f"{API_BASE_URL}{path}", params=params, headers=_AUTH_HEADERS, timeout=15
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as exc:
        st.session_state["_api_error"] = str(exc)
        return None


def trigger_agent(alert_text: str, simulate_crash: bool, chaos_mode: str = "none") -> dict | None:
    return api_post(
        "/incidents/trigger",
        {"alertText": alert_text, "simulateCrash": simulate_crash, "chaosMode": chaos_mode},
    )


def api_post_chaos_sigkill() -> dict | None:
    return api_post("/chaos/sigkill", {})


def fetch_incidents() -> list:
    return api_get("/incidents") or []


def fetch_logs() -> list:
    return api_get("/logs") or []


def fetch_win_rates() -> dict | None:
    return api_get("/metrics/win-rates")


def fetch_impact() -> dict | None:
    return api_get("/metrics/impact")


def fetch_handoffs(incident_id: str | None = None) -> list:
    if incident_id:
        return api_get(f"/incidents/{incident_id}/handoffs") or []
    return api_get("/handoffs") or []


def fetch_causal_chain(incident_id: str) -> dict | None:
    return api_get(f"/incidents/{incident_id}/causal-chain")


def approve_incident(incident_id: str) -> dict | None:
    return api_post(f"/incidents/{incident_id}/approve", {})


def reject_incident(incident_id: str) -> dict | None:
    return api_post(f"/incidents/{incident_id}/reject", {})


# ── Scénarios prédéfinis ─────────────────────────────────────────────────────

PRESET_SCENARIOS = {
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
    "Incident inconnu (scénario exploratoire)": (
        "Kubernetes node pool scaling event detected: 12 pods evicted due to node pressure, "
        "admission webhook timeout 30s, control plane latency 8000ms",
        "default_repair",
    ),
}

ROUTING_MODE_LABELS = {
    "AUTONOMOUS": ("🟢 AUTONOME", "La mémoire vectorielle a une confiance élevée. L'agent agit seul."),
    "PENDING_APPROVAL": ("🟡 APPROBATION REQUISE", "Score RAG moyen ou win-rate < 80%. Validation humaine requise."),
    "EXPLORATORY": ("🔵 EXPLORATOIRE", "Stratégie inconnue ou aucun match RAG. L'agent documente et apprend."),
    "REJECTED": ("🔴 REJETÉ", "L'opérateur a choisi de ne pas appliquer la stratégie."),
}

AGENT_EMOJIS = {
    "diagnostician": "🔍",
    "remediator": "🔧",
    "auditor": "✅",
}


# ── UI ────────────────────────────────────────────────────────────────────────

st.set_page_config(page_title="Cloud-Surgeon — Dashboard", layout="wide", page_icon="☁️")

st.title("☁️🔪 Cloud-Surgeon — Architecture à 3 couches")
st.caption(
    "Couche 1: mémoire causale (RAG + win-rate SQL) · "
    "Couche 2: routage par confiance (AUTONOMOUS/PENDING/EXPLORATORY) · "
    "Couche 3: coordination multi-agents via transactions sérialisables CockroachDB"
)

st.session_state.pop("_api_error", None)
health = api_get("/healthz")
if health and health.get("status") == "ok":
    st.success(f"✅ Backend connecté ({API_BASE_URL}) — état persisté en CockroachDB Serverless")
else:
    reason = st.session_state.get("_api_error", "réponse inattendue")
    st.error(f"❌ Backend inaccessible sur {API_BASE_URL} : {reason}")

# ── Sidebar ───────────────────────────────────────────────────────────────────

with st.sidebar:
    st.header("🚨 Déclencher une panne")

    scenario_label = st.selectbox("Scénario prédéfini", list(PRESET_SCENARIOS.keys()))
    selected_alert_text, selected_strategy = PRESET_SCENARIOS[scenario_label]
    st.caption(f"Stratégie : `{selected_strategy}`")

    custom_text = st.text_area(
        "Ou décris ta propre alerte",
        value="",
        placeholder="Ex: latence réseau anormale sur le VPC prod",
    )
    alert_text = custom_text.strip() or selected_alert_text

    st.divider()
    st.subheader("💥 Chaos engineering")

    chaos_choice = st.selectbox(
        "Mode chaos",
        [
            "Aucun (exécution normale)",
            "🌐 Latence réseau (500 ms / write DB)",
            "🔌 Partition DB (timeout simulé × 2)",
            "💀 Crash SIGKILL après diagnostic",
        ],
        help=(
            "Latence : injecte 500 ms avant chaque écriture DB — prouve que l'agent résiste à un réseau lent.\n"
            "Partition : simule 2 timeouts DB qui se rétablissent — prouve la reprise sans perte de contexte.\n"
            "SIGKILL : tue le process au tour 1 — déclenche à nouveau pour prouver la reprise post-crash."
        ),
    )
    simulate_crash = chaos_choice.startswith("💀")
    chaos_mode = (
        "latency" if chaos_choice.startswith("🌐")
        else "partition" if chaos_choice.startswith("🔌")
        else "none"
    )

    trigger = st.button("⚡ Déclencher l'agent", type="primary", use_container_width=True)

    st.divider()
    st.subheader("☠️ Vrai crash de process")
    st.caption(
        "Envoie SIGKILL au process Node (comme un OOMKiller AWS). "
        "Le workflow manager le redémarre automatiquement. "
        "Déclenche ensuite le même incident pour prouver la reprise depuis CockroachDB."
    )
    if st.button("💀 SIGKILL le serveur API", use_container_width=True, type="secondary"):
        kill_result = api_post_chaos_sigkill()
        if kill_result:
            st.warning(
                f"⚡ SIGKILL envoyé (PID {kill_result.get('pid')}) — "
                "le serveur redémarre dans ~2 s. "
                "Re-déclenche le même scénario pour prouver la reprise."
            )
        else:
            st.error(f"Erreur : {st.session_state.get('_api_error')}")

    st.divider()
    st.subheader("🌐 Webhook CloudWatch")
    st.caption("Simule une alarme CloudWatch → SNS → `POST /api/webhook/cloudwatch`.")
    wh_alarm_name = st.text_input("AlarmName", value="checkout-5xx-spike")
    wh_reason = st.text_input("NewStateReason", value="Threshold Crossed: 3 datapoints > 10.")
    if st.button("📡 Simuler webhook CloudWatch", use_container_width=True):
        result = api_post(
            "/webhook/cloudwatch",
            {
                "AlarmName": wh_alarm_name,
                "NewStateValue": "ALARM",
                "NewStateReason": wh_reason,
                "Region": "us-east-1",
            },
        )
        if result:
            st.success(f"Webhook accepté — incident `{result.get('incidentId', '')[:8]}` ({result.get('status')})")
        else:
            st.error(f"Erreur : {st.session_state.get('_api_error')}")

    st.divider()
    st.subheader("🌱 Mémoire vectorielle")
    if st.button("Réinitialiser le seed", use_container_width=True, help="Insère les 9 incidents synthétiques si absent."):
        seed_result = api_post("/metrics/seed", {})
        if seed_result:
            if seed_result.get("seeded"):
                st.success(f"Seed inséré : {seed_result.get('count')} incidents")
            else:
                st.info(f"Seed déjà présent : {seed_result.get('count')} entrées")
        else:
            st.error(st.session_state.get("_api_error"))


# ── Tabs ──────────────────────────────────────────────────────────────────────

tab_live, tab_decision, tab_incidents, tab_memory, tab_impact, tab_logs = st.tabs([
    "🔴 Diagnostic en direct",
    "🧠 Pourquoi cette décision ?",
    "📋 Incidents",
    "📊 Mémoire & Win-rates",
    "💰 Impact MTTR & Coût",
    "📜 Journal d'exécution",
])


def render_incident_turns(incident: dict) -> None:
    """Affiche les tours de l'agent avec badge agent + source de pensée."""
    ctx = incident.get("contextJson", {})
    turns = ctx.get("turns", [])
    for turn in turns:
        agent = turn.get("agent", "unknown")
        emoji = AGENT_EMOJIS.get(agent, "🤖")
        source = turn.get("thoughtSource", "simulated")
        source_badge = "🧠 Bedrock" if source == "bedrock" else "🤖 Simulé"
        label = f"Tour {turn['turn'] + 1} — {emoji} {agent.capitalize()} · {turn['toolName']} ({source_badge})"
        with st.expander(label, expanded=True):
            st.write(f"**Pensée ({source_badge}) :** {turn['thought']}")
            st.write(f"**Appel d'outil :** `{turn['toolName']}({turn['toolInput']})`")
            st.write(f"**Résultat :** `{turn['toolOutput']}`")


with tab_live:
    if trigger:
        spinner_msg = {
            "none": "Exécution de la boucle d'agent (Diagnostician → Remediator → Auditor)…",
            "latency": "🌐 Mode latence activé — 500 ms injectés avant chaque write DB…",
            "partition": "🔌 Mode partition activé — 2 timeouts DB simulés, reprise automatique…",
        }.get(chaos_mode, "Exécution…")
        with st.spinner(spinner_msg):
            incident = trigger_agent(alert_text, simulate_crash, chaos_mode)

        if incident is None:
            st.error(f"La requête a échoué : {st.session_state.get('_api_error')}")
        else:
            ctx = incident.get("contextJson", {})
            fp_short = incident["alertFingerprint"][:12]
            routing_mode = ctx.get("routingMode", "—")
            claimed_by = incident.get("claimedByAgent", "—")

            st.subheader(f"Incident `{incident['incidentId'][:8]}` · empreinte `{fp_short}…`")

            col1, col2, col3 = st.columns(3)
            col1.metric("Statut", incident["status"])
            col2.metric("Mode de routage", routing_mode or "—")
            col3.metric("Agent en charge", claimed_by or "libéré")

            # Alertes contextuelles selon le statut
            if incident["status"] == "PENDING_APPROVAL":
                st.warning(
                    "🟡 **APPROBATION REQUISE** — L'agent attend une décision humaine. "
                    "Va dans l'onglet **📋 Incidents** pour approuver ou rejeter."
                )
            elif incident["status"] in ("DIAGNOSING", "REPAIRING") and ctx.get("crashed"):
                st.warning(
                    "💥 **Crash simulé** — L'agent s'est arrêté avant la fin. L'état a été persisté. "
                    "Re-déclenche le même scénario pour prouver la reprise sans perte de contexte."
                )
            elif incident["status"] == "RESOLVED":
                st.success(ctx.get("finalResponse") or "Incident résolu.")
            elif incident["status"] == "FAILED":
                st.error(ctx.get("finalResponse") or "Incident échoué.")

            render_incident_turns(incident)

            # Affichage des handoffs
            handoffs = fetch_handoffs(incident["incidentId"])
            if handoffs:
                st.divider()
                st.subheader("🔄 Passations entre agents")
                for h in handoffs:
                    mode = h.get("decisionMode") or ""
                    mode_label = f" [{mode}]" if mode else ""
                    agent = h.get("agentName", "?")
                    emoji = AGENT_EMOJIS.get(agent, "🤖")
                    st.markdown(
                        f"**{emoji} {agent.capitalize()}{mode_label}** — {h.get('note', '')}  \n"
                        f"<sub>{h.get('createdAt', '')}</sub>",
                        unsafe_allow_html=True,
                    )
    else:
        st.caption("Choisis un scénario dans la barre latérale et clique sur « ⚡ Déclencher l'agent ».")


with tab_decision:
    st.header("🧠 Pourquoi cette décision ?")
    st.caption(
        "Pour chaque incident, la Couche 2 consulte la Couche 1 (RAG + win-rate) avant d'agir. "
        "Cette vue explique le raisonnement de l'agent."
    )

    incidents_list = fetch_incidents()
    if not incidents_list:
        st.info("Aucun incident. Déclenche un scénario dans la barre latérale.")
    else:
        incident_options = {
            f"{i['incidentId'][:8]} — {i['status']} ({i.get('currentStep', '?')})": i
            for i in incidents_list
        }
        selected_label = st.selectbox("Sélectionne un incident", list(incident_options.keys()))
        selected_incident = incident_options[selected_label]
        ctx = selected_incident.get("contextJson", {})

        # ── Métriques de décision ───────────────────────────────────────────
        col1, col2, col3, col4 = st.columns(4)

        routing_mode = ctx.get("routingMode")
        routing_label, routing_desc = ROUTING_MODE_LABELS.get(
            routing_mode, ("⚪ —", "Routage non encore calculé.")
        )
        col1.metric("Mode de routage", routing_label)

        rag_score = ctx.get("ragScore")
        if rag_score is not None:
            col2.metric("Score RAG (distance cosinus)", f"{rag_score:.3f}", help="0 = identique, 1 = opposé")
        else:
            col2.metric("Score RAG", "—")

        win_rate = ctx.get("winRate")
        sample_size = ctx.get("winRateSampleSize", 0)
        if win_rate is not None:
            col3.metric(
                "Win-rate stratégie",
                f"{win_rate * 100:.0f}%",
                delta=f"{sample_size} samples",
                delta_color="off",
            )
        else:
            col3.metric("Win-rate stratégie", "—" if sample_size == 0 else f"n={sample_size}")

        strategy = ctx.get("strategyName", "—")
        col4.metric("Stratégie choisie", strategy)

        st.info(routing_desc)

        # ── Explication textuelle ───────────────────────────────────────────
        with st.expander("📖 Logique de routage (Couche 2)", expanded=True):
            st.markdown("""
| Condition | Mode |
|-----------|------|
| Distance RAG < 0.15 **ET** win-rate > 80% | 🟢 **AUTONOMOUS** — agit seul |
| Distance 0.15–0.8 **OU** win-rate ≤ 80% | 🟡 **PENDING_APPROVAL** — attend l'humain |
| Aucun match RAG (distance > 0.8) ou 0 sample | 🔵 **EXPLORATORY** — apprend en documentant |

La mémoire vectorielle (`incident_vectors`) stocke chaque incident résolu avec sa stratégie
et son résultat (`outcome_success`). Le win-rate est calculé par une simple agrégation SQL :

```sql
SELECT strategy_name,
       COUNT(*) FILTER (WHERE outcome_success) * 1.0 / COUNT(*) AS win_rate
FROM incident_vectors
GROUP BY strategy_name
```
""")

        # ── Handoffs ────────────────────────────────────────────────────────
        st.subheader("🔄 Chaîne de responsabilité (Couche 3)")
        handoffs = fetch_handoffs(selected_incident["incidentId"])
        if handoffs:
            for h in handoffs:
                agent = h.get("agentName", "?")
                emoji = AGENT_EMOJIS.get(agent, "🤖")
                mode = h.get("decisionMode")
                mode_label = f" `[{mode}]`" if mode else ""
                st.markdown(
                    f"{emoji} **{agent.capitalize()}**{mode_label} — {h.get('note', '')}",
                )
                st.caption(f"Réclamé à : {h.get('createdAt', '')}")
        else:
            st.caption("Aucune passation enregistrée pour cet incident.")

        # ── Chaîne causale ──────────────────────────────────────────────────
        st.subheader("🔗 Chaîne causale (CTE récursive)")
        chain_data = fetch_causal_chain(selected_incident["incidentId"])
        if chain_data and chain_data.get("chain"):
            chain = chain_data["chain"]
            if len(chain) == 1:
                st.caption("Cet incident n'a pas de parent causal identifié.")
            else:
                for node in chain:
                    depth_indent = "→ " * (max(0, len(chain) - 1 - node["depth"]))
                    st.markdown(
                        f"{depth_indent}`{node['incidentId'][:8]}` "
                        f"**{node['status']}** — profondeur {node['depth']}"
                    )
            st.caption(chain_data.get("note", ""))
        else:
            st.caption("Impossible de récupérer la chaîne causale.")


with tab_incidents:
    col_r, col_a = st.columns([1, 5])
    with col_r:
        if st.button("🔄 Rafraîchir"):
            st.rerun()

    incidents = fetch_incidents()
    if not incidents:
        st.caption("Aucun incident pour l'instant.")
    else:
        # Séparer les incidents PENDING_APPROVAL pour les mettre en avant
        pending = [i for i in incidents if i["status"] == "PENDING_APPROVAL"]
        others = [i for i in incidents if i["status"] != "PENDING_APPROVAL"]

        if pending:
            st.warning(f"🟡 {len(pending)} incident(s) en attente d'approbation humaine")
            for inc in pending:
                ctx = inc.get("contextJson", {})
                strategy = ctx.get("strategyName", "?")
                rag = ctx.get("ragScore")
                wr = ctx.get("winRate")
                rag_str = f"{rag:.3f}" if rag is not None else "—"
                wr_str = f"{wr * 100:.0f}%" if wr is not None else "—"

                with st.container(border=True):
                    st.markdown(
                        f"**`{inc['incidentId'][:8]}`** · stratégie `{strategy}` · "
                        f"RAG: `{rag_str}` · win-rate: `{wr_str}`"
                    )
                    st.caption(f"Alerte : {ctx.get('alertText', '')[:120]}")
                    col_ap, col_rj, _ = st.columns([1, 1, 3])
                    with col_ap:
                        if st.button(
                            "✅ Approuver",
                            key=f"approve_{inc['incidentId']}",
                            type="primary",
                        ):
                            result = approve_incident(inc["incidentId"])
                            if result:
                                st.success("Approuvé — l'agent reprend en mode AUTONOMOUS")
                                time.sleep(1)
                                st.rerun()
                            else:
                                st.error(st.session_state.get("_api_error"))
                    with col_rj:
                        if st.button(
                            "❌ Rejeter",
                            key=f"reject_{inc['incidentId']}",
                        ):
                            result = reject_incident(inc["incidentId"])
                            if result:
                                st.warning("Rejeté — incident clôturé sans action corrective")
                                time.sleep(1)
                                st.rerun()
                            else:
                                st.error(st.session_state.get("_api_error"))

        st.dataframe(
            [
                {
                    "Incident": i["incidentId"][:8],
                    "Statut": i["status"],
                    "Stratégie": (i.get("contextJson") or {}).get("strategyName", "—"),
                    "Mode": (i.get("contextJson") or {}).get("routingMode", "—"),
                    "Agent": i.get("claimedByAgent") or "—",
                    "Étape": i["currentStep"],
                    "Mis à jour": i["updatedAt"],
                }
                for i in (pending + others)
            ],
            use_container_width=True,
            hide_index=True,
        )


with tab_memory:
    st.header("📊 Mémoire évaluée — Couche 1")
    st.caption(
        "Taux de succès par stratégie de résolution. Calculé par agrégation SQL pure sur "
        "`incident_vectors` — un bandit contextuel porté par CockroachDB, sans service ML externe."
    )

    if st.button("🔄 Rafraîchir les métriques"):
        st.rerun()

    wr_data = fetch_win_rates()
    if wr_data and wr_data.get("winRates"):
        rates = wr_data["winRates"]

        # Tableau principal
        st.dataframe(
            [
                {
                    "Stratégie": r["strategyName"],
                    "Win-rate": f"{r['winRate'] * 100:.0f}%",
                    "Succès": r["successCount"],
                    "Total": r["totalCount"],
                    "Échecs": r["totalCount"] - r["successCount"],
                }
                for r in rates
            ],
            use_container_width=True,
            hide_index=True,
        )

        # Visualisation barre
        import pandas as pd
        df = pd.DataFrame([
            {"Stratégie": r["strategyName"], "Win-rate (%)": round(r["winRate"] * 100, 1)}
            for r in rates
        ])
        st.bar_chart(df.set_index("Stratégie"), y="Win-rate (%)", use_container_width=True)

        st.caption(
            "SQL : `SELECT strategy_name, COUNT(*) FILTER (WHERE outcome_success) * 1.0 / COUNT(*) AS win_rate "
            "FROM incident_vectors GROUP BY strategy_name`"
        )

        st.divider()
        st.subheader("📐 Seuils de routage (Couche 2)")
        st.markdown("""
- **Win-rate > 80% + distance RAG < 0.15** → `AUTONOMOUS` (l'agent agit seul)
- **Win-rate ≤ 80% ou distance 0.15–0.8** → `PENDING_APPROVAL` (validation humaine)
- **Distance > 0.8 ou 0 sample** → `EXPLORATORY` (nouvelle stratégie, mode apprentissage)
""")
    else:
        st.info("Aucune donnée dans la mémoire vectorielle. Déclenche quelques incidents d'abord.")


with tab_impact:
    st.header("💰 Impact MTTR & Coût — Agent vs. Humain d'astreinte")
    st.caption(
        "Chaque incident enregistre son timestamp de déclenchement (`triggered_at`) et de résolution "
        "(`resolved_at`) dans CockroachDB. Le MTTR est calculé en SQL pur. "
        "Le coût en Request Units est estimé à partir du modèle de facturation CockroachDB Serverless."
    )

    col_r_imp, _ = st.columns([1, 5])
    with col_r_imp:
        if st.button("🔄 Rafraîchir", key="refresh_impact"):
            st.rerun()

    impact = fetch_impact()

    if impact is None:
        st.error(f"Impossible de charger les métriques : {st.session_state.get('_api_error')}")
    else:
        resolved = impact.get("incidentsResolved", 0)
        mttr = impact.get("mttrStats", {})
        cost = impact.get("costStats", {})
        autonomy = impact.get("autonomyBreakdown", {})

        mttr_avg = mttr.get("avgSeconds")
        human_baseline = mttr.get("humanBaselineSeconds", 1200)
        reduction_pct = mttr.get("reductionPct")

        # ── Ligne 1 : métriques MTTR ────────────────────────────────────────
        st.subheader("⏱️ MTTR — Mean Time To Resolve")
        c1, c2, c3, c4 = st.columns(4)
        if mttr_avg is not None:
            c1.metric(
                "MTTR Agent (mesuré)",
                f"{mttr_avg:.1f} s",
                delta=f"−{reduction_pct}% vs humain" if reduction_pct else None,
                delta_color="normal",
                help="Calculé depuis triggered_at → resolved_at dans CockroachDB",
            )
        else:
            c1.metric("MTTR Agent (mesuré)", "—", help="Résoudre au moins un incident pour voir le MTTR.")
        c2.metric(
            "Baseline humaine estimée",
            f"{human_baseline} s ({human_baseline // 60} min)",
            help="Source : Atlassian State of Incidents 2023 — MTTR médian P1 cloud = 18–22 min.",
        )
        c3.metric(
            "Incidents résolus",
            resolved,
            delta=f"{impact.get('incidentsFailed', 0)} échoués",
            delta_color="off",
        )
        c4.metric(
            "Incidents actifs",
            impact.get("incidentsActive", 0) + impact.get("incidentsPending", 0),
            help="En cours + en attente d'approbation humaine",
        )

        if mttr_avg is not None and reduction_pct is not None:
            speedup = human_baseline / mttr_avg if mttr_avg > 0 else 0
            st.success(
                f"✅ **L'agent est {speedup:.0f}× plus rapide** qu'un SRE humain d'astreinte "
                f"({mttr_avg:.1f} s vs {human_baseline} s), soit **{reduction_pct}% de réduction du MTTR**."
            )
        elif resolved == 0:
            st.info("💡 Déclenche quelques incidents dans la barre latérale pour mesurer le MTTR.")

        st.divider()

        # ── Ligne 2 : coût ──────────────────────────────────────────────────
        st.subheader("💵 Coût — Agent vs. SRE d'astreinte")
        cc1, cc2, cc3, cc4 = st.columns(4)
        agent_cost = cost.get("estimatedAgentCostUsd", 0)
        human_total = cost.get("humanTotalCostIfManual", 0)
        savings = cost.get("estimatedSavingsUsd", 0)
        total_ru = cost.get("totalRuConsumed", 0)

        cc1.metric(
            "Coût agent estimé (RU CockroachDB)",
            f"${agent_cost:.4f}",
            help=f"{total_ru} RU × $1/million = ${agent_cost:.6f}",
        )
        cc2.metric(
            "Coût humain équivalent",
            f"${human_total:.2f}",
            help=f"{resolved} incidents × ${cost.get('humanBaselineCostUsdPerIncident', 35):.0f}/incident",
        )
        cc3.metric(
            "Économies estimées",
            f"${savings:.2f}",
            delta=f"−{round((1 - agent_cost / human_total) * 100) if human_total > 0 else 100}%",
            delta_color="normal",
        )
        cc4.metric(
            "RU CockroachDB consommées",
            f"{total_ru:,}",
            delta=f"~{cost.get('avgRuPerIncident', 42):.0f} RU/incident",
            delta_color="off",
        )

        with st.expander("📋 Hypothèses de coût", expanded=False):
            for h in cost.get("hypotheses", []):
                st.markdown(f"- {h}")
            st.caption(
                "Ces estimations sont conservatrices et documentées pour la transparence envers le jury. "
                "En production avec Bedrock activé, le coût Sonnet 3.5 (~3 $/1M tokens) s'ajouterait."
            )

        st.divider()

        # ── Ligne 3 : autonomie ─────────────────────────────────────────────
        st.subheader("🤖 Répartition par mode de routage (Couche 2)")
        ac1, ac2, ac3, ac4 = st.columns(4)
        total_all = max(1, sum(autonomy.values()))
        ac1.metric(
            "🟢 AUTONOMOUS",
            autonomy.get("autonomous", 0),
            delta=f"{autonomy.get('autonomous', 0) / total_all * 100:.0f}%",
            delta_color="off",
            help="Agent a agi seul : win-rate > 80% sur stratégie connue",
        )
        ac2.metric(
            "🟡 PENDING_APPROVAL",
            autonomy.get("pendingApproval", 0),
            delta=f"{autonomy.get('pendingApproval', 0) / total_all * 100:.0f}%",
            delta_color="off",
            help="Win-rate ≤ 80% : validation humaine requise",
        )
        ac3.metric(
            "🔵 EXPLORATORY",
            autonomy.get("exploratory", 0),
            delta=f"{autonomy.get('exploratory', 0) / total_all * 100:.0f}%",
            delta_color="off",
            help="Stratégie inconnue : l'agent documente et apprend",
        )
        ac4.metric(
            "🔴 REJECTED",
            autonomy.get("rejected", 0),
            delta=f"{autonomy.get('rejected', 0) / total_all * 100:.0f}%",
            delta_color="off",
            help="Rejeté par l'humain avant exécution",
        )

        # Visualisation barre autonomie
        import pandas as pd
        autonomy_df = pd.DataFrame([
            {"Mode": "AUTONOMOUS", "Incidents": autonomy.get("autonomous", 0)},
            {"Mode": "PENDING_APPROVAL", "Incidents": autonomy.get("pendingApproval", 0)},
            {"Mode": "EXPLORATORY", "Incidents": autonomy.get("exploratory", 0)},
            {"Mode": "REJECTED", "Incidents": autonomy.get("rejected", 0)},
        ])
        st.bar_chart(autonomy_df.set_index("Mode"), use_container_width=True)

        # ── MTTR par stratégie ───────────────────────────────────────────────
        mttr_by_strategy = impact.get("mttrByStrategy", [])
        if mttr_by_strategy:
            st.divider()
            st.subheader("⏱️ MTTR par stratégie de réparation")
            st.caption("Uniquement les incidents RESOLVED avec resolved_at enregistré.")
            mttr_df = pd.DataFrame([
                {
                    "Stratégie": r["strategyName"] or "—",
                    "Incidents": r["incidentCount"],
                    "MTTR moy. (s)": round(r["mttrAvgSeconds"], 1) if r.get("mttrAvgSeconds") else "—",
                    "MTTR min (s)": round(r["mttrMinSeconds"], 1) if r.get("mttrMinSeconds") else "—",
                    "MTTR max (s)": round(r["mttrMaxSeconds"], 1) if r.get("mttrMaxSeconds") else "—",
                    "vs humain": (
                        f"−{round((1 - r['mttrAvgSeconds'] / human_baseline) * 100)}%"
                        if r.get("mttrAvgSeconds") else "—"
                    ),
                }
                for r in mttr_by_strategy
            ])
            st.dataframe(mttr_df, use_container_width=True, hide_index=True)

            # Chart
            chart_df = pd.DataFrame([
                {"Stratégie": r["strategyName"] or "—", "MTTR (s)": r.get("mttrAvgSeconds") or 0}
                for r in mttr_by_strategy if r.get("mttrAvgSeconds")
            ])
            if not chart_df.empty:
                import altair as alt
                baseline_line = alt.Chart(
                    pd.DataFrame([{"MTTR (s)": human_baseline}])
                ).mark_rule(color="red", strokeDash=[6, 4]).encode(y="MTTR (s):Q")
                bars = alt.Chart(chart_df).mark_bar().encode(
                    x=alt.X("Stratégie:N", sort="-y"),
                    y=alt.Y("MTTR (s):Q"),
                    color=alt.value("#4C8BF5"),
                    tooltip=["Stratégie:N", "MTTR (s):Q"],
                )
                st.altair_chart(bars + baseline_line, use_container_width=True)
                st.caption("🔴 Ligne rouge = baseline humaine (1 200 s). Toutes les barres en dessous = l'agent est plus rapide.")

        # SQL hint
        with st.expander("🔍 SQL de calcul MTTR", expanded=False):
            st.code("""
SELECT
  context_json->>'strategyName' AS strategy_name,
  COUNT(*) AS incident_count,
  ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - triggered_at))), 2) AS mttr_avg_seconds
FROM incident_state
WHERE status = 'RESOLVED'
  AND resolved_at IS NOT NULL
GROUP BY context_json->>'strategyName'
ORDER BY mttr_avg_seconds ASC;
            """, language="sql")


with tab_logs:
    col_r2, _ = st.columns([1, 5])
    with col_r2:
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
                    "Action": l["actionTaken"][:80],
                    "Résultat": (l["result"] or "")[:120],
                    "Horodatage": l["createdAt"],
                }
                for l in logs
            ],
            use_container_width=True,
            hide_index=True,
        )

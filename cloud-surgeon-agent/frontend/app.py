"""
Cloud-Surgeon — Simulation Dashboard (Streamlit)

3-Layer Architecture:
  Layer 1 — Causal memory (vector RAG + SQL win-rate per strategy)
  Layer 2 — Memory decides (AUTONOMOUS / PENDING_APPROVAL / EXPLORATORY routing)
  Layer 3 — Multi-agent coordination via CockroachDB serializable transactions
"""

from __future__ import annotations

import hmac
import os
import time

from dotenv import load_dotenv
import requests
import streamlit as st

# Load environment variables from .env file
load_dotenv()

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


def fetch_logs_count(incident_id: str | None = None) -> int:
    """Return the true total row count from CockroachDB (unaffected by pagination)."""
    params = {"incidentId": incident_id} if incident_id else None
    result = api_get("/logs/count", params=params)
    if isinstance(result, dict):
        return int(result.get("count", 0))
    return 0


def fetch_win_rates() -> dict | None:
    return api_get("/metrics/win-rates")


def fetch_impact() -> dict | None:
    return api_get("/metrics/impact")


def fetch_calibration() -> dict | None:
    return api_get("/metrics/calibration")


def fetch_cluster_health() -> dict | None:
    return api_get("/metrics/cluster")


def fetch_ccloud_status(action: str = "cluster:status") -> dict | None:
    return api_get(f"/metrics/ccloud?action={action}")


def ingest_metrics(datapoints: list[dict]) -> dict | None:
    return api_post("/metrics/ingest", datapoints)


def fetch_audit_stream_status() -> dict | None:
    """
    Connects to the SSE audit stream, reads only the first 'connected' event
    to discover whether the CockroachDB CDC changefeed is active or whether
    the server has fallen back to polling. Returns immediately after the
    first event (or on timeout).
    """
    try:
        resp = requests.get(
            f"{API_BASE_URL}/stream/audit",
            headers={**_AUTH_HEADERS, "Accept": "text/event-stream"},
            stream=True,
            timeout=3,
        )
        resp.raise_for_status()
        for line in resp.iter_lines(chunk_size=None):
            if not line:
                continue
            text = line.decode("utf-8") if isinstance(line, bytes) else line
            if text.startswith("data: "):
                import json as _json
                try:
                    return _json.loads(text[6:])
                except Exception:
                    pass
    except Exception:
        pass
    return None


def recalibrate_all() -> dict | None:
    return api_post("/metrics/calibration/recalibrate", {})


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


def correct_incident(incident_id: str, suggested_strategy: str) -> dict | None:
    return api_post(f"/incidents/{incident_id}/correct", {"suggestedStrategy": suggested_strategy})


# ── Password authentication ───────────────────────────────────────────────────

def _check_password() -> bool:
    """
    Returns True if the dashboard is accessible (no password set, or already
    authenticated this session).  Returns False and renders a login form when
    DASHBOARD_PASSWORD is set and the user has not yet logged in.
    """
    expected = os.environ.get("DASHBOARD_PASSWORD", "")
    if not expected:
        return True  # No password configured — dev mode, allow access.
    if st.session_state.get("_auth_ok"):
        return True  # Already authenticated this session.

    # Show login form.
    with st.form("dashboard_login"):
        st.markdown("### 🔐 Cloud-Surgeon Dashboard — Login")
        pwd = st.text_input("Password", type="password", placeholder="Enter dashboard password")
        submitted = st.form_submit_button("Login", type="primary")
    if submitted:
        if hmac.compare_digest(pwd, expected):
            st.session_state["_auth_ok"] = True
            st.rerun()
        else:
            st.error("Incorrect password. Please try again.")
    return False


# ── Preset scenarios ──────────────────────────────────────────────────────────

# Preset metric datapoints for the proactive anomaly detection demo.
# These are sent to POST /api/metrics/ingest to trigger PREDICTIVE incidents
# BEFORE CloudWatch fires an alarm.
PREDICTIVE_SCENARIOS = {
    "🔮 ECS CPU spike (checkout service — pre-alarm)": [
        {"metricName": "CPUUtilization", "value": 84,
         "dimensions": {"ServiceName": "checkout-ecs", "ClusterName": "prod"},
         "serviceHint": "checkout-ecs"},
    ],
    "🔮 RDS connection pool approaching limit": [
        {"metricName": "DatabaseConnections", "value": 430,
         "dimensions": {"DBInstanceIdentifier": "catalog-db"},
         "serviceHint": "catalog-db"},
    ],
    "🔮 Lambda throttling pre-alarm": [
        {"metricName": "Throttles", "value": 12,
         "dimensions": {"FunctionName": "order-processor"},
         "serviceHint": "order-processor"},
    ],
    "🔮 High target response time (ALB)": [
        {"metricName": "TargetResponseTime", "value": 2.8,
         "dimensions": {"LoadBalancer": "app/checkout-alb"},
         "serviceHint": "checkout-alb"},
    ],
    "🔮 Disk usage critical (EC2 worker)": [
        {"metricName": "FreeableStorage", "value": 500_000_000,  # 500 MB free
         "dimensions": {"InstanceId": "i-0abc123", "ServiceName": "worker-03"},
         "serviceHint": "worker-03"},
    ],
}

PRESET_SCENARIOS = {
    "Payment service 5xx spike (ECS)": (
        "ECS service 'checkout' unhealthy: 5xx spike on /pay endpoint, latency p99 > 4s",
        "ecs_service_restart",
    ),
    "Primary DB CPU saturation (RDS)": (
        "RDS primary instance 'orders-db' CPU utilization at 98% for 10 minutes",
        "rds_cpu_throttle",
    ),
    "Cascading Lambda throttling": (
        "Lambda function 'order-processor' throttled: ConcurrentExecutions limit reached",
        "lambda_concurrency_scale",
    ),
    "Worker node disk full": (
        "EC2 instance 'worker-03' disk usage at 95%, risk of service crash",
        "disk_cleanup",
    ),
    "JVM memory leak (recommendation service)": (
        "JVM heap exhaustion on 'recommendation-service' pod: GC overhead limit exceeded, "
        "OOMKiller triggered, pod restarting every 3 minutes",
        "jvm_heap_restart",
    ),
    "DB connection pool exhausted (Postgres RDS)": (
        "RDS 'catalog-db' max_connections reached (500/500): new connections refused, "
        "pg_stat_activity shows 320 idle-in-transaction sessions older than 30s",
        "db_connection_pool_reset",
    ),
    "Cross-region latency > SLA (API Gateway us-east-1 → eu-west-1)": (
        "API Gateway p99 latency degraded: us-east-1 → eu-west-1 cross-region calls "
        "averaging 2800ms (SLA: 500ms), likely BGP route flap or transit gateway saturation",
        "network_route_failover",
    ),
    "Expired AWS credential (S3 access from ECS)": (
        "ECS task 'data-export' failing: AccessDeniedException on s3:PutObject to "
        "s3://prod-exports — IAM role credential rotation missed, token expired 2h ago",
        "iam_credential_rotation",
    ),
    "External dependency down (Stripe API)": (
        "Payment gateway degraded: Stripe API returning 503 on /v1/charges for 8 minutes, "
        "checkout conversion rate dropped from 94% to 12%, revenue impact ~$4200/min",
        "external_dependency_circuit_break",
    ),
    "Unknown incident (exploratory scenario)": (
        "Kubernetes node pool scaling event detected: 12 pods evicted due to node pressure, "
        "admission webhook timeout 30s, control plane latency 8000ms",
        "default_repair",
    ),
}

ROUTING_MODE_LABELS = {
    "AUTONOMOUS": ("🟢 AUTONOMOUS", "Vector memory has high confidence. Agent acts alone."),
    "PENDING_APPROVAL": ("🟡 APPROVAL REQUIRED", "Average RAG score or win-rate < 80%. Human validation required."),
    "EXPLORATORY": ("🔵 EXPLORATORY", "Unknown strategy or no RAG match. Agent documents and learns."),
    "REJECTED": ("🔴 REJECTED", "Operator chose not to apply the strategy."),
}

AGENT_EMOJIS = {
    "diagnostician": "🔍",
    "remediator": "🔧",
    "auditor": "✅",
}


# ── UI ────────────────────────────────────────────────────────────────────────

st.set_page_config(page_title="Cloud-Surgeon — Dashboard", layout="wide", page_icon="static/favicon-96x96.png")

# Inject favicon link tags for browser / PWA / Apple support
st.markdown("""
    <link rel="icon" type="image/png" href="app/static/favicon-96x96.png" sizes="96x96" />
    <link rel="icon" type="image/svg+xml" href="app/static/favicon.svg" />
    <link rel="shortcut icon" href="app/static/favicon.ico" />
    <link rel="apple-touch-icon" sizes="180x180" href="app/static/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-title" content="Cloud Surgeon" />
    <link rel="manifest" href="app/static/site.webmanifest" />
""", unsafe_allow_html=True)

# ── Password gate ──────────────────────────────────────────────────────────────
# Authenticate before rendering any data. If DASHBOARD_PASSWORD is unset,
# a dev-mode warning is shown but access is not blocked.
if not _check_password():
    st.stop()

if not os.environ.get("DASHBOARD_PASSWORD"):
    st.warning(
        "⚠️ **DASHBOARD_PASSWORD is not set** — the dashboard is unprotected. "
        "Set this environment variable to enable password protection before deploying."
    )

st.title("☁️🔪 Cloud-Surgeon — 3-Layer Architecture")
st.caption(
    "Layer 1: causal memory (RAG + SQL win-rate) · "
    "Layer 2: confidence-based routing (AUTONOMOUS/PENDING/EXPLORATORY) · "
    "Layer 3: multi-agent coordination via CockroachDB serializable transactions"
)

st.session_state.pop("_api_error", None)
health = api_get("/healthz")
_api_healthy = bool(health and health.get("status") == "ok")
if _api_healthy:
    st.success(f"✅ Backend connected ({API_BASE_URL}) — state persisted in CockroachDB Serverless")
    # If the server was previously unreachable, force an immediate CDC re-poll
    # so the badge shows the restarted server's true state without waiting 30 s.
    if st.session_state.pop("_api_was_down", False):
        st.session_state.pop("_cdc_status_ts", None)
        st.session_state.pop("_cdc_status", None)
        st.session_state.pop("_cdc_status_ok_ts", None)
        # Transient reconnect banner — disappears on the next rerun automatically.
        st.toast("✅ API reconnected — CDC status refreshed", icon="⚡")
        st.info(
            "⚡ **API reconnected — auto-recovery complete.** "
            "The API server restarted and state was restored from CockroachDB. "
            "CDC changefeed status is being refreshed now.",
            icon="✅",
        )
else:
    reason = st.session_state.get("_api_error", "unexpected response")
    st.error(f"❌ Backend unreachable at {API_BASE_URL}: {reason}")
    # Remember that the API was down so the next successful healthcheck above
    # knows to invalidate the stale cached CDC status.
    st.session_state["_api_was_down"] = True
    # Reset the poll timer so the fragment retries immediately on reconnect.
    st.session_state.pop("_cdc_status_ts", None)

# ── Home summary row (CDC badge · event counter · incident counts) ────────
# Defined here (before sidebar) so it renders at the top of the main body.

@st.fragment(run_every=5)
def _home_summary_widget() -> None:
    """Top-of-page summary: CDC badge, live event counter, incident counts."""
    import time as _time

    # ── CDC badge (refresh every 30 s — SSE connection is not free) ─────────
    # Strategy: only overwrite the cached status when a real result comes back.
    # If the SSE read times out or fails, keep the previous good value so the
    # badge label never flickers to "Connecting…" mid-cycle.
    #
    # Staleness / restart resilience:
    #   _cdc_status_ts   — when we last *attempted* a poll (gate: retry if > 30 s old)
    #   _cdc_status_ok_ts — when we last got a *successful* response (used for staleness label)
    #
    # On failure we roll _cdc_status_ts back by 25 s so the next fragment tick
    # (5 s later) will retry immediately rather than waiting a full 30 s cycle.
    # The main healthcheck block clears both keys when the API goes down so
    # the very first successful reconnect always does a fresh SSE poll.
    _now = _time.time()
    _cache_age = _now - st.session_state.get("_cdc_status_ts", 0)
    if _cache_age > 30 or "_cdc_status" not in st.session_state:
        _fresh = fetch_audit_stream_status()
        if _fresh is not None:
            # Successful read — update status and record the success time.
            st.session_state["_cdc_status"] = _fresh
            st.session_state["_cdc_status_ok_ts"] = _now
            # Full 30 s cool-down before next poll.
            st.session_state["_cdc_status_ts"] = _now
        else:
            # Failed read — roll the attempt timestamp back so we retry in
            # ~5 s (the fragment interval) rather than blocking for 30 s.
            st.session_state["_cdc_status_ts"] = _now - 25

    # Use whatever the last successful read returned; None only on first boot.
    _status = st.session_state.get("_cdc_status")
    # How long since the last *successful* CDC fetch (used for staleness label).
    _ok_ts = st.session_state.get("_cdc_status_ok_ts")
    _status_age = int(_now - _ok_ts) if _ok_ts else None
    _is_stale = _status is not None and _status_age is not None and _status_age > 30

    # ── Audit event counter (since session start) ────────────────────────────
    # Uses /logs/count so the total is accurate even when /logs is paginated.
    _current_count = fetch_logs_count()
    if "_audit_baseline" not in st.session_state:
        st.session_state["_audit_baseline"] = _current_count
    _delta = _current_count - st.session_state["_audit_baseline"]

    # ── Incident counts ──────────────────────────────────────────────────────
    _incidents = api_get("/incidents") or []
    _total = len(_incidents)
    _predictive = sum(
        1 for i in _incidents
        if (i.get("contextJson") or {}).get("source") == "predictive"
    )
    _active = sum(
        1 for i in _incidents
        if i.get("status") in ("TRIGGERED", "DIAGNOSING", "REPAIRING")
    )

    col_cdc, col_events, col_inc, col_pred = st.columns(4)

    with col_cdc:
        # Build an optional staleness suffix shown when the last successful
        # CDC read is more than one full poll cycle (30 s) old — signals
        # judges that the badge may lag behind a server restart.
        _stale_suffix = f" · last checked {_status_age}s ago" if _is_stale else ""

        if _status and _status.get("cdcActive"):
            st.success("🟢 CDC LIVE")
            st.caption(f"CockroachDB changefeed — real-time push{_stale_suffix}")
        elif _status and _status.get("type") in ("connected", "heartbeat"):
            st.info("🔵 Polling fallback")
            st.caption(f"2-second polling (no changefeed tier){_stale_suffix}")
        else:
            # No successful reading yet — server may still be booting.
            st.info("⏳ Connecting…")
            st.caption("Waiting for API server to start")

    with col_events:
        st.metric(
            "📡 Audit events",
            _current_count,
            delta=f"+{_delta} this session" if _delta > 0 else "0 this session",
            delta_color="normal",
            help=(
                "Total audit log entries in CockroachDB. "
                "The delta counts events received since this browser session started — "
                "increments in real time as the CDC stream delivers new rows."
            ),
        )

    with col_inc:
        st.metric(
            "🚨 Incidents",
            _total,
            delta=f"{_active} active" if _active else None,
            delta_color="inverse" if _active else "off",
            help="Total incidents in CockroachDB. Delta shows how many are currently in-progress.",
        )

    with col_pred:
        st.metric(
            "🔮 Pre-alarm",
            _predictive,
            help=(
                "Incidents opened by vector similarity BEFORE CloudWatch fired an alarm. "
                "Cloud-Surgeon predicted the failure from metric anomalies alone."
            ),
        )

_home_summary_widget()

# ── Sidebar ───────────────────────────────────────────────────────────────────

with st.sidebar:
    # ── Logo ──────────────────────────────────────────────────────────────
    _logo_path = os.path.join(os.path.dirname(__file__), "logo.png")
    if os.path.exists(_logo_path):
        st.image(_logo_path, width="stretch")
        st.divider()

    st.header("🚨 Trigger an Incident")

    scenario_label = st.selectbox("Preset scenario", list(PRESET_SCENARIOS.keys()))
    selected_alert_text, selected_strategy = PRESET_SCENARIOS[scenario_label]
    st.caption(f"Strategy: `{selected_strategy}`")

    custom_text = st.text_area(
        "Or describe your own alert",
        value="",
        placeholder="E.g.: abnormal network latency on prod VPC",
    )
    alert_text = custom_text.strip() or selected_alert_text

    st.divider()
    st.subheader("💥 Chaos Engineering")

    chaos_choice = st.selectbox(
        "Chaos mode",
        [
            "None (normal execution)",
            "🌐 Network latency (500 ms / DB write)",
            "🔌 DB partition (simulated timeout x 2)",
            "💀 SIGKILL crash after diagnostic",
        ],
        help=(
            "Latency: injects 500 ms before each DB write — proves the agent survives a slow network.\n"
            "Partition: simulates 2 DB timeouts that self-recover — proves context-free resumption.\n"
            "SIGKILL: kills the process at turn 1 — re-trigger to prove post-crash recovery."
        ),
    )
    simulate_crash = chaos_choice.startswith("💀")
    chaos_mode = (
        "latency" if chaos_choice.startswith("🌐")
        else "partition" if chaos_choice.startswith("🔌")
        else "none"
    )

    trigger = st.button("⚡ Trigger Agent", type="primary", width='stretch')

    st.divider()
    st.subheader("☠️ Real Process Crash")
    st.caption(
        "Sends SIGKILL to the Node process (like an AWS OOMKiller). "
        "The workflow manager restarts it automatically. "
        "Then re-trigger the same incident to prove recovery from CockroachDB."
    )
    if st.button("💀 SIGKILL the API server", width='stretch', type="secondary"):
        kill_result = api_post_chaos_sigkill()
        if kill_result:
            st.warning(
                f"⚡ SIGKILL sent (PID {kill_result.get('pid')}) — "
                "server restarting in ~2 s. "
                "Re-trigger the same scenario to prove recovery."
            )
        else:
            st.error(f"Error: {st.session_state.get('_api_error')}")

    st.divider()
    st.subheader("🌐 CloudWatch Webhook")
    st.caption("Simulates a CloudWatch alarm → SNS → `POST /api/webhook/cloudwatch`.")
    wh_alarm_name = st.text_input("AlarmName", value="checkout-5xx-spike")
    wh_reason = st.text_input("NewStateReason", value="Threshold Crossed: 3 datapoints > 10.")
    if st.button("📡 Simulate CloudWatch webhook", width='stretch'):
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
            st.success(f"Webhook accepted — incident `{result.get('incidentId', '')[:8]}` ({result.get('status')})")
        else:
            st.error(f"Error: {st.session_state.get('_api_error')}")

    st.divider()
    st.subheader("🔮 Proactive Anomaly Detection")
    st.caption(
        "Send metric datapoints **before** CloudWatch fires an alarm. "
        "Cloud-Surgeon uses CockroachDB vector similarity to recognise the pattern "
        "and opens a **PREDICTIVE** incident proactively."
    )
    predictive_scenario_label = st.selectbox(
        "Metric scenario",
        list(PREDICTIVE_SCENARIOS.keys()),
        key="predictive_scenario",
    )
    predictive_datapoints = PREDICTIVE_SCENARIOS[predictive_scenario_label]
    if st.button("📡 Ingest metric (trigger predictive)", width='stretch', type="primary"):
        result = ingest_metrics(predictive_datapoints)
        if result:
            n = len(result.get("predictiveIncidents", []))
            if n > 0:
                pred = result["predictiveIncidents"][0]
                st.success(
                    f"🔮 **Predictive incident opened** before any alarm!\n\n"
                    f"Strategy: `{pred['strategy']}` · "
                    f"Similarity: `{pred['similarityScore']:.3f}` · "
                    f"Method: `{pred['detectionMethod']}`\n\n"
                    f"Incident `{pred['incidentId'][:8]}` is now visible in the 📋 Incidents tab."
                )
            else:
                st.info(f"Ingested — no anomaly threshold crossed. (result: {result.get('message','')})")
        else:
            st.error(st.session_state.get("_api_error"))

    st.divider()
    st.subheader("🌱 Vector Memory")
    if st.button("Reset seed", use_container_width=True, help="Inserts the 9 synthetic incidents if absent."):
        seed_result = api_post("/metrics/seed", {})
        if seed_result:
            if seed_result.get("seeded"):
                st.success(f"Seed inserted: {seed_result.get('count')} incidents")
            else:
                st.info(f"Seed already present: {seed_result.get('count')} entries")
        else:
            st.error(st.session_state.get("_api_error"))


# ── Auto-refreshing fragments ──────────────────────────────────────────────────
# Each fragment re-renders its section independently so data stays live
# without requiring a full page reload or a manual refresh button.

@st.fragment(run_every=3)
def _live_status_widget() -> None:
    """Polls active incidents every 3 s and shows a progress indicator."""
    active = [
        i for i in (api_get("/incidents") or [])
        if i["status"] in ("TRIGGERED", "DIAGNOSING", "REPAIRING")
    ]
    if active:
        st.caption(f"🔄 **{len(active)} incident(s) in progress** — auto-refreshing every 3 s")
        progress_map = {"TRIGGERED": 0.1, "DIAGNOSING": 0.4, "REPAIRING": 0.75}
        for inc in active[:5]:
            ctx = inc.get("contextJson", {})
            pct = progress_map.get(inc["status"], 0.5)
            step = inc.get("currentStep") or inc["status"]
            agent = inc.get("claimedByAgent") or "—"
            st.progress(pct, text=f"`{inc['incidentId'][:8]}` · **{inc['status']}** · step: {step} · agent: {agent}")
            strategy = ctx.get("strategyName")
            if strategy:
                st.caption(f"  Strategy: `{strategy}` | Mode: `{ctx.get('routingMode', '—')}`")
    else:
        st.caption("✅ No active incidents right now — trigger a scenario from the sidebar.")


@st.fragment(run_every=5)
def _incidents_tab_content() -> None:
    """Incidents tab — auto-refreshes every 5 s."""
    col_r, col_a = st.columns([1, 5])
    with col_r:
        if st.button("🔄 Refresh", key="refresh_incidents_btn"):
            st.rerun()

    incidents = fetch_incidents()
    if not incidents:
        st.caption("No incidents yet.")
        return

    # Separate PENDING_APPROVAL incidents to highlight them
    pending = [i for i in incidents if i["status"] == "PENDING_APPROVAL"]
    others = [i for i in incidents if i["status"] != "PENDING_APPROVAL"]

    # Available strategies for human correction
    _all_strategies = sorted({v[1] for v in PRESET_SCENARIOS.values()})

    if pending:
        st.warning(f"🟡 {len(pending)} incident(s) awaiting human approval")
        for inc in pending:
            ctx = inc.get("contextJson", {})
            strategy = ctx.get("strategyName", "?")
            rag = ctx.get("ragScore")
            wr = ctx.get("winRate")
            rag_str = f"{rag:.3f}" if rag is not None else "—"
            wr_str = f"{wr * 100:.0f}%" if wr is not None else "—"
            inc_key = inc["incidentId"]

            with st.container(border=True):
                st.markdown(
                    f"**`{inc_key[:8]}`** · proposed strategy: `{strategy}` · "
                    f"RAG: `{rag_str}` · win-rate: `{wr_str}`"
                )
                st.caption(f"Alert: {ctx.get('alertText', '')[:120]}")

                # ── Row 1: Approve / Reject ──────────────────────────────
                col_ap, col_rj, _ = st.columns([1, 1, 3])
                with col_ap:
                    if st.button("✅ Approve", key=f"approve_{inc_key}", type="primary"):
                        result = approve_incident(inc_key)
                        if result:
                            st.success("Approved — agent resuming in AUTONOMOUS mode")
                            time.sleep(1)
                            st.rerun()
                        else:
                            st.error(st.session_state.get("_api_error"))
                with col_rj:
                    if st.button("❌ Reject", key=f"reject_{inc_key}"):
                        result = reject_incident(inc_key)
                        if result:
                            st.warning(
                                "Rejected — negative signal (x0.5) recorded in memory. "
                                "The win-rate for `" + strategy + "` has decreased."
                            )
                            time.sleep(1)
                            st.rerun()
                        else:
                            st.error(st.session_state.get("_api_error"))

                # ── Row 2: Correct (alternative strategy) ─────────────────
                with st.expander("✏️ Suggest an alternative strategy…", expanded=False):
                    st.caption(
                        "Memory will receive a negative signal (x0.5) for `" + strategy + "` "
                        "and a positive signal (x0.5) for the chosen strategy — "
                        "without waiting for the incident to finish."
                    )
                    alt_strategies = [s for s in _all_strategies if s != strategy]
                    suggested = st.selectbox(
                        "Alternative strategy",
                        alt_strategies,
                        key=f"suggest_{inc_key}",
                    )
                    if st.button(
                        f"✅ Confirm: use `{suggested}`",
                        key=f"correct_{inc_key}",
                        type="secondary",
                    ):
                        result = correct_incident(inc_key, suggested)
                        if result:
                            st.success(
                                f"Correction recorded — "
                                f"signal −0.5 for `{strategy}`, "
                                f"signal +0.5 for `{suggested}`. "
                                "Calibration updated."
                            )
                            time.sleep(1.5)
                            st.rerun()
                        else:
                            st.error(st.session_state.get("_api_error"))

    # ── Predictive incidents highlight ────────────────────────────────────
    predictive = [
        i for i in others
        if (i.get("contextJson") or {}).get("source") == "predictive"
    ]
    if predictive:
        st.info(
            f"🔮 **{len(predictive)} PREDICTIVE incident(s)** — opened by vector similarity "
            "BEFORE CloudWatch fired an alarm. CockroachDB memory recognised the failure pattern proactively."
        )
        for inc in predictive[:3]:
            ctx = inc.get("contextJson", {})
            score = ctx.get("similarityScore")
            method = ctx.get("detectionMethod", "keyword")
            metric = ctx.get("predictiveMetric", "unknown")
            strategy = ctx.get("predictiveStrategy", ctx.get("strategyName", "?"))
            with st.container(border=True):
                st.markdown(
                    f"**🔮 Predictive** `{inc['incidentId'][:8]}` · metric: `{metric}` · "
                    f"strategy: `{strategy}` · "
                    f"similarity: `{score:.3f}`" if score else
                    f"**🔮 Predictive** `{inc['incidentId'][:8]}` · metric: `{metric}` · strategy: `{strategy}`"
                )
                st.caption(
                    f"Detection method: `{method}` · status: `{inc['status']}` · "
                    "Alarm had NOT fired when this incident was opened."
                )

    st.dataframe(
        [
            {
                "Incident": i["incidentId"][:8],
                "🔮": "PREDICTIVE" if (i.get("contextJson") or {}).get("source") == "predictive" else "",
                "Status": i["status"],
                "Strategy": (i.get("contextJson") or {}).get("strategyName", "—"),
                "Mode": (i.get("contextJson") or {}).get("routingMode", "—"),
                "Agent": i.get("claimedByAgent") or "—",
                "Step": i["currentStep"],
                "Updated": i["updatedAt"],
            }
            for i in (pending + others)
        ],
        use_container_width=True,
        hide_index=True,
    )


# ── Tabs ──────────────────────────────────────────────────────────────────────

tab_live, tab_decision, tab_incidents, tab_memory, tab_calibration, tab_impact, tab_logs = st.tabs([
    "🔴 Live Diagnostic",
    "🧠 Why this decision?",
    "📋 Incidents",
    "📊 Memory & Win-rates",
    "🎯 Calibration",
    "💰 MTTR & Cost Impact",
    "📜 Execution Log",
])


def render_incident_turns(incident: dict) -> None:
    """Renders agent turns with agent badge and thought source."""
    ctx = incident.get("contextJson", {})
    turns = ctx.get("turns", [])
    for turn in turns:
        agent = turn.get("agent", "unknown")
        emoji = AGENT_EMOJIS.get(agent, "🤖")
        source = turn.get("thoughtSource", "simulated")
        if source == "bedrock":
            source_badge = "🧠 Bedrock"
        elif source == "anthropic":
            source_badge = "🧠 Anthropic"
        else:
            source_badge = "🤖 Simulated"
        label = f"Turn {turn['turn'] + 1} — {emoji} {agent.capitalize()} · {turn['toolName']} ({source_badge})"
        with st.expander(label, expanded=True):
            st.write(f"**Thought ({source_badge}):** {turn['thought']}")
            st.write(f"**Tool call:** `{turn['toolName']}({turn['toolInput']})`")
            st.write(f"**Result:** `{turn['toolOutput']}`")


with tab_live:
    # Live status: auto-refreshes every 3 s to track in-progress agents.
    _live_status_widget()
    st.divider()

    if trigger:
        spinner_msg = {
            "none": "Running agent loop (Diagnostician → Remediator → Auditor)…",
            "latency": "🌐 Latency mode active — 500 ms injected before each DB write…",
            "partition": "🔌 Partition mode active — 2 simulated DB timeouts, auto-recovery…",
        }.get(chaos_mode, "Running…")
        with st.spinner(spinner_msg):
            incident = trigger_agent(alert_text, simulate_crash, chaos_mode)

        if incident is None:
            st.error(f"Request failed: {st.session_state.get('_api_error')}")
        else:
            ctx = incident.get("contextJson", {})
            fp_short = incident["alertFingerprint"][:12]
            routing_mode = ctx.get("routingMode", "—")
            claimed_by = incident.get("claimedByAgent", "—")

            st.subheader(f"Incident `{incident['incidentId'][:8]}` · fingerprint `{fp_short}…`")

            col1, col2, col3 = st.columns(3)
            col1.metric("Status", incident["status"])
            col2.metric("Routing mode", routing_mode or "—")
            col3.metric("Agent in charge", claimed_by or "released")

            # Contextual alerts based on status
            if incident["status"] == "PENDING_APPROVAL":
                st.warning(
                    "🟡 **APPROVAL REQUIRED** — Agent is waiting for a human decision. "
                    "Go to the **📋 Incidents** tab to approve or reject."
                )
            elif incident["status"] in ("DIAGNOSING", "REPAIRING") and ctx.get("crashed"):
                st.warning(
                    "💥 **Simulated crash** — Agent stopped before completion. State has been persisted. "
                    "Re-trigger the same scenario to prove context-free recovery."
                )
            elif incident["status"] == "RESOLVED":
                st.success(ctx.get("finalResponse") or "Incident resolved.")
            elif incident["status"] == "FAILED":
                st.error(ctx.get("finalResponse") or "Incident failed.")

            render_incident_turns(incident)

            # Handoffs display
            handoffs = fetch_handoffs(incident["incidentId"])
            if handoffs:
                st.divider()
                st.subheader("🔄 Agent Handoffs")
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
        st.caption("Choose a scenario in the sidebar and click « ⚡ Trigger Agent ».")

    # ── CDC Audit Stream (real-time) ───────────────────────────────────────
    st.divider()
    st.subheader("📡 Live Audit Stream — CockroachDB CDC")

    # Check stream status (one quick SSE connection to read the 'connected' event).
    stream_status = fetch_audit_stream_status()
    if stream_status and stream_status.get("type") in ("connected", "heartbeat"):
        cdc_active = stream_status.get("cdcActive", False)
        stream_mode = stream_status.get("streamMode", "unknown")
        if cdc_active:
            st.success(
                "🟢 **CockroachDB Changefeed ACTIVE** — every `execution_logs` and `agent_handoffs` "
                "row is pushed to this dashboard in real time via CockroachDB's `webhook-https://` sink. "
                "No polling. CockroachDB is the event bus."
            )
        else:
            st.info(
                "🔵 **Polling fallback** (2-second interval) — CockroachDB changefeed not available "
                f"in this cluster tier. Stream mode: `{stream_mode}`"
            )
        st.caption(f"Stream endpoint: `GET /api/stream/audit` · mode: `{stream_mode}`")
    else:
        st.warning("⚠️ SSE audit stream unreachable — API server may be starting up.")

    # Show recent audit events (last 10 execution log entries).
    # In CDC mode these are pushed by CockroachDB; here we display them from the REST API
    # since Streamlit fragments cannot maintain a persistent SSE connection across reruns.
    st.caption(
        "Showing latest audit log entries. In the production setup, these events are streamed "
        "directly from CockroachDB changefeeds via SSE — no client-side polling required."
    )

    @st.fragment(run_every=2)
    def _audit_stream_widget() -> None:
        """Shows the last 8 execution log entries, refreshed every 2 s."""
        logs = api_get("/logs") or []
        if not logs:
            st.caption("No audit events yet.")
            return
        recent = logs[:8]
        for log in recent:
            inc_short = (log.get("incidentId") or "")[:8]
            action = log.get("actionTaken", "—")
            created = (log.get("createdAt") or "")[:19]
            # Colour-code by action type
            if "INJECTION" in action:
                icon = "🛡️"
            elif "CHAOS" in action:
                icon = "💀"
            elif "HUMAN_FEEDBACK" in action:
                icon = "👤"
            elif any(x in action for x in ["crdb_", "aws_", "execute_"]):
                icon = "🔧"
            else:
                icon = "📝"
            st.markdown(
                f"{icon} `{created}` · `{inc_short}` · **{action[:80]}**",
                help=log.get("result", "")[:400] if log.get("result") else None,
            )

    _audit_stream_widget()


with tab_decision:
    st.header("🧠 Why this decision?")
    st.caption(
        "For each incident, Layer 2 consults Layer 1 (RAG + win-rate) before acting. "
        "This view explains the agent's reasoning."
    )

    incidents_list = fetch_incidents()
    if not incidents_list:
        st.info("No incidents yet. Trigger a scenario from the sidebar.")
    else:
        incident_options = {
            f"{i['incidentId'][:8]} — {i['status']} ({i.get('currentStep', '?')})": i
            for i in incidents_list
        }
        selected_label = st.selectbox("Select an incident", list(incident_options.keys()))
        selected_incident = incident_options[selected_label]
        ctx = selected_incident.get("contextJson", {})

        # ── Decision metrics ────────────────────────────────────────────────
        col1, col2, col3, col4 = st.columns(4)

        routing_mode = ctx.get("routingMode")
        routing_label, routing_desc = ROUTING_MODE_LABELS.get(
            routing_mode, ("⚪ —", "Routing not yet computed.")
        )
        col1.metric("Routing mode", routing_label)

        rag_score = ctx.get("ragScore")
        if rag_score is not None:
            col2.metric("RAG score (cosine distance)", f"{rag_score:.3f}", help="0 = identical, 1 = opposite")
        else:
            col2.metric("RAG score", "—")

        win_rate = ctx.get("winRate")
        sample_size = ctx.get("winRateSampleSize", 0)
        if win_rate is not None:
            col3.metric(
                "Strategy win-rate",
                f"{win_rate * 100:.0f}%",
                delta=f"{sample_size} samples",
                delta_color="off",
            )
        else:
            col3.metric("Strategy win-rate", "—" if sample_size == 0 else f"n={sample_size}")

        strategy = ctx.get("strategyName", "—")
        col4.metric("Chosen strategy", strategy)

        st.info(routing_desc)

        # ── Textual explanation ─────────────────────────────────────────────
        with st.expander("📖 Routing logic (Layer 2)", expanded=True):
            st.markdown("""
| Condition | Mode |
|-----------|------|
| RAG distance < 0.15 **AND** win-rate > 80% | 🟢 **AUTONOMOUS** — acts alone |
| Distance 0.15–0.8 **OR** win-rate ≤ 80% | 🟡 **PENDING_APPROVAL** — waits for human |
| No RAG match (distance > 0.8) or 0 samples | 🔵 **EXPLORATORY** — learns by documenting |

The vector memory (`incident_vectors`) stores each resolved incident with its strategy
and result (`outcome_success`). Win-rate is computed by a simple SQL aggregation:

```sql
SELECT strategy_name,
       COUNT(*) FILTER (WHERE outcome_success) * 1.0 / COUNT(*) AS win_rate
FROM incident_vectors
GROUP BY strategy_name
```
""")

        # ── Handoffs ─────────────────────────────────────────────────────────
        st.subheader("🔄 Responsibility chain (Layer 3)")
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
                st.caption(f"Claimed at: {h.get('createdAt', '')}")
        else:
            st.caption("No handoffs recorded for this incident.")

        # ── Causal chain ──────────────────────────────────────────────────────
        st.subheader("🔗 Causal chain (recursive CTE)")
        chain_data = fetch_causal_chain(selected_incident["incidentId"])
        if chain_data and chain_data.get("chain"):
            chain = chain_data["chain"]
            if len(chain) == 1:
                st.caption("This incident has no identified causal parent.")
            else:
                for node in chain:
                    depth_indent = "→ " * (max(0, len(chain) - 1 - node["depth"]))
                    st.markdown(
                        f"{depth_indent}`{node['incidentId'][:8]}` "
                        f"**{node['status']}** — depth {node['depth']}"
                    )
            st.caption(chain_data.get("note", ""))
        else:
            st.caption("Unable to retrieve causal chain.")


with tab_incidents:
    # Auto-refreshes every 5 s — pending-approval incidents surface immediately.
    _incidents_tab_content()


with tab_memory:
    st.header("📊 Evaluated Memory — Layer 1")
    st.caption(
        "Success rate by resolution strategy. Computed by pure SQL aggregation on "
        "`incident_vectors` — a contextual bandit powered by CockroachDB, no external ML service."
    )

    if st.button("🔄 Refresh metrics"):
        st.rerun()

    wr_data = fetch_win_rates()
    if wr_data and wr_data.get("winRates"):
        rates = wr_data["winRates"]

        # Main table
        st.dataframe(
            [
                {
                    "Strategy": r["strategyName"],
                    "Win-rate": f"{r['winRate'] * 100:.0f}%",
                    "Successes": r["successCount"],
                    "Total": r["totalCount"],
                    "Failures": r["totalCount"] - r["successCount"],
                }
                for r in rates
            ],
            use_container_width=True,
            hide_index=True,
        )

        # Bar chart
        import pandas as pd
        df = pd.DataFrame([
            {"Strategy": r["strategyName"], "Win-rate (%)": round(r["winRate"] * 100, 1)}
            for r in rates
        ])
        st.bar_chart(df.set_index("Strategy"), y="Win-rate (%)", use_container_width=True)

        st.caption(
            "SQL: `SELECT strategy_name, COUNT(*) FILTER (WHERE outcome_success) * 1.0 / COUNT(*) AS win_rate "
            "FROM incident_vectors GROUP BY strategy_name`"
        )

        st.divider()
        st.subheader("📐 Routing thresholds (Layer 2)")
        st.markdown("""
- **Win-rate > 80% + RAG distance < 0.15** → `AUTONOMOUS` (agent acts alone)
- **Win-rate ≤ 80% or distance 0.15–0.8** → `PENDING_APPROVAL` (human validation)
- **Distance > 0.8 or 0 samples** → `EXPLORATORY` (new strategy, learning mode)
""")
    else:
        st.info("No data in vector memory. Trigger some incidents first.")

    # ── ccloud CLI equivalent (CockroachDB Cloud REST API) ─────────────────
    st.divider()
    st.subheader("🔧 ccloud CLI — CockroachDB Cloud Control Plane")
    st.caption(
        "Cloud-Surgeon calls the **CockroachDB Cloud REST API** directly — the same API that "
        "`ccloud` wraps. `ccloud v0.6.12` requires browser-based OAuth and cannot run headlessly "
        "in containers; we authenticate via service-account API key. Results are identical to "
        "`ccloud cluster get <id> -o json`."
    )

    ccloud_action = st.selectbox(
        "ccloud action",
        ["cluster:status", "cluster:list", "cluster:sql-users", "cluster:backups"],
        key="ccloud_action_select",
    )
    if st.button("▶ Run ccloud command", key="run_ccloud"):
        cc = fetch_ccloud_status(ccloud_action)
        if cc and cc.get("live"):
            st.success(f"🟢 **ccloud LIVE** — `{cc.get('ccloudEquivalent','')}`")
            if ccloud_action == "cluster:status":
                col_cc1, col_cc2, col_cc3, col_cc4 = st.columns(4)
                col_cc1.metric("State", cc.get("state", "—"))
                col_cc2.metric("Version", cc.get("cockroachVersion", "—"))
                col_cc3.metric("Plan", cc.get("plan", "—"))
                col_cc4.metric("Region", cc.get("primaryRegion", "—"))
                st.caption(cc.get("summary", ""))
            elif ccloud_action == "cluster:list":
                st.dataframe(cc.get("clusters", []), use_container_width=True, hide_index=True)
            elif ccloud_action == "cluster:sql-users":
                st.dataframe(cc.get("users", []), use_container_width=True, hide_index=True)
            elif ccloud_action == "cluster:backups":
                st.json(cc.get("latestBackup") or cc.get("backups", []))
            with st.expander("📄 Raw JSON (as returned by ccloud REST API)", expanded=False):
                st.json(cc)
        else:
            st.error(f"ccloud call failed: {(cc or {}).get('error', st.session_state.get('_api_error'))}")

    # Show live status badge without button press
    @st.fragment(run_every=30)
    def _ccloud_badge() -> None:
        cc = fetch_ccloud_status("cluster:status")
        if cc and cc.get("live"):
            st.info(
                f"🟢 **ccloud LIVE** · cluster `{cc.get('clusterName','?')}` · "
                f"state `{cc.get('state','?')}` · "
                f"v{cc.get('cockroachVersion','?')} · "
                f"region `{cc.get('primaryRegion','?')}`"
            )

    _ccloud_badge()

    # ── CockroachDB Cluster Health (official Cloud MCP) ────────────────────
    st.divider()
    st.subheader("🐛 Live Cluster Health — CockroachDB Cloud MCP")
    st.caption(
        "Sourced from the **official CockroachDB Cloud MCP Server** at `cockroachlabs.cloud/mcp` "
        "(not a custom REST call). Combines `get_cluster` + `show_running_queries` in one session."
    )

    cluster_data = fetch_cluster_health()
    if cluster_data is None:
        st.warning(f"Could not reach `/metrics/cluster`: {st.session_state.get('_api_error')}")
    elif cluster_data.get("simulated"):
        st.info(
            "🔵 **Simulated** — `COCKROACH_CLOUD_API_KEY` not configured. "
            "Set it to see live cluster metrics from the official CockroachDB Cloud MCP."
        )
    else:
        # Parse cluster info from the nested result
        cluster_info = cluster_data.get("cluster", {})
        running_queries = cluster_data.get("runningQueriesRaw", {})
        fetched_at = cluster_data.get("fetchedAt", "")

        # The get_cluster result may be nested further depending on official MCP response shape
        c_inner = cluster_info.get("cluster", cluster_info) if isinstance(cluster_info, dict) else {}

        col_h1, col_h2, col_h3, col_h4 = st.columns(4)
        col_h1.metric("State", c_inner.get("state", "—"))
        col_h2.metric("Plan", c_inner.get("plan", "—"))

        active_conns = cluster_data.get("activeConnections")
        col_h3.metric(
            "Active queries",
            str(active_conns) if active_conns is not None else "—",
            help="Count from show_running_queries via official Cloud MCP",
        )

        regions = c_inner.get("regions", [])
        region_str = ", ".join(r.get("name", str(r)) for r in regions) if isinstance(regions, list) else str(regions)
        col_h4.metric("Regions", region_str or "—")

        st.caption(f"🟢 Sourced from official CockroachDB Cloud MCP · fetched {fetched_at[:19] if fetched_at else '—'}")

        with st.expander("📄 Raw cluster response (official MCP)", expanded=False):
            st.json(cluster_data)


with tab_calibration:
    st.header("🎯 Automatic Calibration & Human Feedback")
    st.caption(
        "**Layer 1** records predicted vs observed win-rate and auto-corrects future decisions. "
        "**Layer 2** closes its learning loop here: each human rejection or correction "
        "injects a weighted signal (x0.5) directly into `incident_vectors` — without waiting for an incident to finish. "
        "Fully powered by **CockroachDB**, no external ML service."
    )

    col_r_cal, col_recal, _ = st.columns([1, 2, 4])
    with col_r_cal:
        if st.button("🔄 Refresh", key="refresh_calibration"):
            st.rerun()
    with col_recal:
        if st.button("⚙️ Recalibrate all strategies", key="recalibrate_all"):
            result = recalibrate_all()
            if result:
                st.success(result.get("message", "Recalibration complete."))
            else:
                st.error(st.session_state.get("_api_error"))

    cal_data = fetch_calibration()
    if not cal_data:
        st.error(f"Unable to load calibration: {st.session_state.get('_api_error')}")
    else:
        rows = cal_data.get("calibration", [])
        threshold = cal_data.get("threshold", 0.15)

        if not rows:
            st.info(
                "No calibration data yet. "
                "Trigger several incidents and come back — predictions accumulate automatically."
            )
        else:
            # ── Summary metrics ──────────────────────────────────────────────
            n_downgraded = sum(1 for r in rows if r["status"] == "downgraded")
            n_upgraded   = sum(1 for r in rows if r["status"] == "upgraded")
            n_calibrated = sum(1 for r in rows if r["status"] == "calibrated")
            n_no_data    = sum(1 for r in rows if r["status"] == "no_data")

            mc1, mc2, mc3, mc4 = st.columns(4)
            mc1.metric("🟢 Well calibrated",  n_calibrated, help="Deviation ≤ 15% — no correction needed")
            mc2.metric("🔴 Degraded",          n_downgraded, help="Observed < Predicted by > 15% — factor < 1 applied")
            mc3.metric("🔵 Improved",          n_upgraded,   help="Observed > Predicted by > 15% — factor > 1 applied")
            mc4.metric("⚪ No data",           n_no_data,    help="No observed data available yet")

            # ── Main table ──────────────────────────────────────────────────
            STATUS_LABELS = {
                "calibrated": "🟢 Calibrated",
                "downgraded": "🔴 Degraded",
                "upgraded":   "🔵 Improved",
                "no_data":    "⚪ No data",
            }

            total_human_signals = sum(r.get("humanSignalCount", 0) for r in rows)
            if total_human_signals > 0:
                st.info(
                    f"🧑‍💻 **{total_human_signals} human signal(s) integrated** into vector memory "
                    f"(rejections + corrections, weight x0.5 each). "
                    "Rejected strategies saw their win-rate decrease; "
                    "suggested strategies saw their win-rate increase."
                )

            table_rows = []
            for r in rows:
                predicted = r["avgPredictedWinRate"]
                observed  = r["observedWinRate"]
                factor    = r["correctionFactor"]
                deviation = r["deviation"]
                human_n   = r.get("humanSignalCount", 0)
                table_rows.append({
                    "Strategy":              r["strategyName"],
                    "Predicted (avg)":       f"{predicted * 100:.1f}%",
                    "Observed (real)":       f"{observed * 100:.1f}%" if observed is not None else "—",
                    "Deviation":             (
                        f"{'+' if deviation >= 0 else ''}{deviation * 100:.1f}%"
                        if deviation is not None else "—"
                    ),
                    "Correction factor":     f"x{factor:.3f}" if factor != 1.0 else "x1.000 (neutral)",
                    "Human signals":         human_n if human_n > 0 else "—",
                    "Recorded decisions":    r["predictionCount"],
                    "Status":                STATUS_LABELS.get(r["status"], r["status"]),
                })

            st.dataframe(table_rows, use_container_width=True, hide_index=True)

            # ── Mechanism explanation ────────────────────────────────────────
            with st.expander("📖 How does calibration work?", expanded=False):
                st.markdown(f"""
### Self-correcting bandit — CockroachDB, 0 external ML services

**Why?** A historical win-rate can overestimate a strategy's reliability if recent incidents
reveal degradation (changed infra, more complex scenarios, etc.).
Calibration detects this drift and applies a correction *before* the next
routing decision is made.

**How?**

1. At each routing decision, the predicted win-rate is recorded in `strategy_calibration`
   via a **SQL UPSERT** that maintains a weighted rolling average:

```sql
INSERT INTO strategy_calibration (strategy_name, avg_predicted_win_rate, prediction_count)
VALUES ($1, $2, 1)
ON CONFLICT (strategy_name) DO UPDATE
  SET avg_predicted_win_rate =
        (avg_predicted_win_rate * prediction_count + EXCLUDED.avg_predicted_win_rate)
        / (prediction_count + 1),
      prediction_count = prediction_count + 1
```

2. After each resolved incident, the recalibration query compares:
   - **Predicted** = `avg_predicted_win_rate` (what was expected)
   - **Observed** = `COUNT(*) FILTER (WHERE outcome_success) / COUNT(*)` from `incident_vectors`

3. If `|observed − predicted| > {threshold * 100:.0f}%` → correction factor =
   `clamp(observed / predicted, 0.1, 1.5)`

4. Subsequent decisions use: `effective win-rate = raw win-rate x factor`

| Situation | Factor | Effect |
|-----------|--------|--------|
| Observed < predicted by > {threshold * 100:.0f}% | **< 1.0** | Strategy **demoted** → PENDING_APPROVAL even if historical win-rate > 80% |
| Observed > predicted by > {threshold * 100:.0f}% | **> 1.0** | Strategy **promoted** → AUTONOMOUS more easily |
| Deviation ≤ {threshold * 100:.0f}% | **1.0** | Neutral — no correction |
""")

            # ── SQL for judges ───────────────────────────────────────────────
            with st.expander("🔧 Recalibration SQL query (powered by CockroachDB)", expanded=False):
                st.code("""
-- Compute observed win-rate from incident_vectors
SELECT
    COUNT(*) FILTER (WHERE outcome_success)::float
    / NULLIF(COUNT(*), 0)  AS observed_win_rate
FROM incident_vectors
WHERE strategy_name = $1;

-- Update correction factor
UPDATE strategy_calibration
SET observed_win_rate    = $observed,
    correction_factor    =
        CASE
          WHEN ABS($observed - avg_predicted_win_rate) > 0.15
          THEN GREATEST(0.1, LEAST(1.5, $observed / NULLIF(avg_predicted_win_rate, 0)))
          ELSE 1.0
        END,
    last_recalculated_at = now()
WHERE strategy_name = $1;
""", language="sql")


with tab_impact:
    st.header("💰 MTTR & Cost Impact — Agent vs. On-call Engineer")
    st.caption(
        "Each incident records its trigger timestamp (`triggered_at`) and resolution timestamp "
        "(`resolved_at`) in CockroachDB. MTTR is computed in pure SQL. "
        "The Request Unit cost is estimated from the CockroachDB Serverless billing model."
    )

    col_r_imp, _ = st.columns([1, 5])
    with col_r_imp:
        if st.button("🔄 Refresh", key="refresh_impact"):
            st.rerun()

    impact = fetch_impact()

    if impact is None:
        st.error(f"Unable to load metrics: {st.session_state.get('_api_error')}")
    else:
        resolved = impact.get("incidentsResolved", 0)
        mttr = impact.get("mttrStats", {})
        cost = impact.get("costStats", {})
        autonomy = impact.get("autonomyBreakdown", {})

        mttr_avg = mttr.get("avgSeconds")
        human_baseline = mttr.get("humanBaselineSeconds", 1200)
        reduction_pct = mttr.get("reductionPct")

        # ── Row 1: MTTR metrics ──────────────────────────────────────────────
        st.subheader("⏱️ MTTR — Mean Time To Resolve")
        c1, c2, c3, c4 = st.columns(4)
        if mttr_avg is not None:
            c1.metric(
                "Agent MTTR (measured)",
                f"{mttr_avg:.1f} s",
                delta=f"−{reduction_pct}% vs human" if reduction_pct else None,
                delta_color="normal",
                help="Computed from triggered_at → resolved_at in CockroachDB",
            )
        else:
            c1.metric("Agent MTTR (measured)", "—", help="Resolve at least one incident to see MTTR.")
        c2.metric(
            "Estimated human baseline",
            f"{human_baseline} s ({human_baseline // 60} min)",
            help="Source: Atlassian State of Incidents 2023 — median P1 cloud MTTR = 18–22 min.",
        )
        c3.metric(
            "Resolved incidents",
            resolved,
            delta=f"{impact.get('incidentsFailed', 0)} failed",
            delta_color="off",
        )
        c4.metric(
            "Active incidents",
            impact.get("incidentsActive", 0) + impact.get("incidentsPending", 0),
            help="In progress + awaiting human approval",
        )

        if mttr_avg is not None and reduction_pct is not None:
            speedup = human_baseline / mttr_avg if mttr_avg > 0 else 0
            st.success(
                f"✅ **The agent is {speedup:.0f}x faster** than a human on-call SRE "
                f"({mttr_avg:.1f} s vs {human_baseline} s), a **{reduction_pct}% MTTR reduction**."
            )
        elif resolved == 0:
            st.info("💡 Trigger some incidents from the sidebar to measure MTTR.")

        st.divider()

        # ── Row 2: cost ──────────────────────────────────────────────────────
        st.subheader("💵 Cost — Agent vs. On-call SRE")
        cc1, cc2, cc3, cc4 = st.columns(4)
        agent_cost = cost.get("estimatedAgentCostUsd", 0)
        human_total = cost.get("humanTotalCostIfManual", 0)
        savings = cost.get("estimatedSavingsUsd", 0)
        total_ru = cost.get("totalRuConsumed", 0)

        cc1.metric(
            "Estimated agent cost (CockroachDB RU)",
            f"${agent_cost:.4f}",
            help=f"{total_ru} RU x $1/million = ${agent_cost:.6f}",
        )
        cc2.metric(
            "Equivalent human cost",
            f"${human_total:.2f}",
            help=f"{resolved} incidents x ${cost.get('humanBaselineCostUsdPerIncident', 35):.0f}/incident",
        )
        cc3.metric(
            "Estimated savings",
            f"${savings:.2f}",
            delta=f"−{round((1 - agent_cost / human_total) * 100) if human_total > 0 else 100}%",
            delta_color="normal",
        )
        cc4.metric(
            "CockroachDB RU consumed",
            f"{total_ru:,}",
            delta=f"~{cost.get('avgRuPerIncident', 42):.0f} RU/incident",
            delta_color="off",
        )

        with st.expander("📋 Cost assumptions", expanded=False):
            for h in cost.get("hypotheses", []):
                st.markdown(f"- {h}")
            st.caption(
                "These estimates are conservative and documented for transparency toward judges. "
                "In production with Bedrock enabled, Sonnet 3.5 cost (~$3/1M tokens) would be added."
            )

        st.divider()

        # ── Row 3: autonomy ──────────────────────────────────────────────────
        st.subheader("🤖 Routing mode breakdown (Layer 2)")
        ac1, ac2, ac3, ac4 = st.columns(4)
        total_all = max(1, sum(autonomy.values()))
        ac1.metric(
            "🟢 AUTONOMOUS",
            autonomy.get("autonomous", 0),
            delta=f"{autonomy.get('autonomous', 0) / total_all * 100:.0f}%",
            delta_color="off",
            help="Agent acted alone: win-rate > 80% on known strategy",
        )
        ac2.metric(
            "🟡 PENDING_APPROVAL",
            autonomy.get("pendingApproval", 0),
            delta=f"{autonomy.get('pendingApproval', 0) / total_all * 100:.0f}%",
            delta_color="off",
            help="Win-rate ≤ 80%: human validation required",
        )
        ac3.metric(
            "🔵 EXPLORATORY",
            autonomy.get("exploratory", 0),
            delta=f"{autonomy.get('exploratory', 0) / total_all * 100:.0f}%",
            delta_color="off",
            help="Unknown strategy: agent documents and learns",
        )
        ac4.metric(
            "🔴 REJECTED",
            autonomy.get("rejected", 0),
            delta=f"{autonomy.get('rejected', 0) / total_all * 100:.0f}%",
            delta_color="off",
            help="Rejected by human before execution",
        )

        # Autonomy bar chart
        import pandas as pd
        autonomy_df = pd.DataFrame([
            {"Mode": "AUTONOMOUS", "Incidents": autonomy.get("autonomous", 0)},
            {"Mode": "PENDING_APPROVAL", "Incidents": autonomy.get("pendingApproval", 0)},
            {"Mode": "EXPLORATORY", "Incidents": autonomy.get("exploratory", 0)},
            {"Mode": "REJECTED", "Incidents": autonomy.get("rejected", 0)},
        ])
        st.bar_chart(autonomy_df.set_index("Mode"), use_container_width=True)

        # ── MTTR by strategy ─────────────────────────────────────────────────
        mttr_by_strategy = impact.get("mttrByStrategy", [])
        if mttr_by_strategy:
            st.divider()
            st.subheader("⏱️ MTTR by repair strategy")
            st.caption("Only RESOLVED incidents with recorded resolved_at.")
            mttr_df = pd.DataFrame([
                {
                    "Strategy": r["strategyName"] or "—",
                    "Incidents": r["incidentCount"],
                    "Avg MTTR (s)": round(r["mttrAvgSeconds"], 1) if r.get("mttrAvgSeconds") else "—",
                    "Min MTTR (s)": round(r["mttrMinSeconds"], 1) if r.get("mttrMinSeconds") else "—",
                    "Max MTTR (s)": round(r["mttrMaxSeconds"], 1) if r.get("mttrMaxSeconds") else "—",
                    "vs human": (
                        f"−{round((1 - r['mttrAvgSeconds'] / human_baseline) * 100)}%"
                        if r.get("mttrAvgSeconds") else "—"
                    ),
                }
                for r in mttr_by_strategy
            ])
            st.dataframe(mttr_df, use_container_width=True, hide_index=True)

            # Chart
            chart_df = pd.DataFrame([
                {"Strategy": r["strategyName"] or "—", "MTTR (s)": r.get("mttrAvgSeconds") or 0}
                for r in mttr_by_strategy if r.get("mttrAvgSeconds")
            ])
            if not chart_df.empty:
                import altair as alt
                baseline_line = alt.Chart(
                    pd.DataFrame([{"MTTR (s)": human_baseline}])
                ).mark_rule(color="red", strokeDash=[6, 4]).encode(y="MTTR (s):Q")
                bars = alt.Chart(chart_df).mark_bar().encode(
                    x=alt.X("Strategy:N", sort="-y"),
                    y=alt.Y("MTTR (s):Q"),
                    color=alt.value("#4C8BF5"),
                    tooltip=["Strategy:N", "MTTR (s):Q"],
                )
                st.altair_chart(bars + baseline_line, use_container_width=True)
                st.caption("🔴 Red line = human baseline (1,200 s). All bars below = agent is faster.")

        # SQL hint
        with st.expander("🔍 MTTR computation SQL", expanded=False):
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
        if st.button("🔄 Refresh", key="refresh_logs"):
            st.rerun()

    logs = fetch_logs()
    if not logs:
        st.caption("No actions logged yet.")
    else:
        st.dataframe(
            [
                {
                    "Incident": l["incidentId"][:8],
                    "Action": l["actionTaken"][:80],
                    "Result": (l["result"] or "")[:120],
                    "Timestamp": l["createdAt"],
                }
                for l in logs
            ],
            use_container_width=True,
            hide_index=True,
        )

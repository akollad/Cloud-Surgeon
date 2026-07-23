# Cloud-Surgeon — Demo Script
**Target duration: 2 min 30 sec**
**Format: screen recording of the live dashboard — NO terminal needed. Every action is done through the dashboard UI.**

---

## PRE-RECORDING SETUP (do this before hitting record)

1. Open the dashboard in your browser: `https://<your-replit-url>/dashboard/`
2. Log in with your `DASHBOARD_PASSWORD`
3. Make sure the **right-side Controls panel is visible** (click the sliders icon on mobile, or expand it on desktop)
4. Navigate to the **Guide** page (first item in the left nav) — this is your starting screen
5. In the Controls panel (right side):
   - Set **Scenario** dropdown to → `"ECS service checkout: payment 5xx spike"`
   - Set **Chaos Engineering** dropdown to → `"None"`
6. Verify the **API Online** green dot is visible in the top-left of the left nav
7. Open a second browser tab at the same URL — you'll use it to quickly switch pages during recording

---

## [0:00 – 0:18] — OPENING

**What's on screen:** Guide page. Left nav shows "API Online" in green. Right Controls panel is visible.

> 🎙️ *"It's 2 AM. Your payment service is going down. Every second costs money. Nobody is awake. Cloud-Surgeon never sleeps."*

> 🎙️ *"Cloud-Surgeon is an autonomous AI DevOps agent. It detects, diagnoses, and repairs AWS infrastructure incidents — with no human intervention — using CockroachDB as its persistent memory and decision engine."*

**👉 HOLD on the Guide page for the full 18 seconds. Let the narration play over the dashboard.**

---

## [0:18 – 0:22] — TRIGGER INCIDENT (Scenario A)

**What to do:**
1. In the **Controls panel** (right side), confirm the Scenario dropdown shows → `"ECS service checkout: payment 5xx spike"`
2. Confirm Chaos Engineering is set to → `"None"`
3. Click **"Trigger Agent"** button

> 🎙️ *"Scenario one: an ECS payment service is throwing 5xx errors. We trigger the agent."*

**👉 You will see a toast notification appear: "Incident Triggered · [incident-id]"**

---

## [0:22 – 0:55] — LIVE DIAGNOSTIC (watching the agent work)

**What to do:**
1. Immediately click **"Live Diagnostic"** in the left navigation menu
2. You will see the incident card appear on screen — it starts as **TRIGGERED** (red border, pulsing)
3. Watch as it transitions: `TRIGGERED → DIAGNOSING → REPAIRING`
4. The CDC Audit Stream at the bottom will start scrolling real-time logs

> 🎙️ *"The Diagnostician agent queries CloudWatch, inspects the ECS service state, then runs a vector similarity search in CockroachDB — looking for past incidents that match this pattern."*

**👉 Pause on the log stream scrolling. Let the judges see the real-time events.**

> 🎙️ *"It finds a match: 'ECS service restart' — 74% win rate, above the 70% autonomous threshold. Confidence is high enough. The Remediator acts autonomously, no human approval needed."*

**👉 Watch the incident card flash green when it reaches RESOLVED.**

---

## [0:55 – 1:10] — DECISION TRACE

**What to do:**
1. Click **"Decision Trace"** in the left navigation menu
2. Select the incident that just resolved from the dropdown at the top

> 🎙️ *"Here is the full decision trace: the incident vector, the strategy selected, the win rate from CockroachDB memory, and the reasoning of each agent — all committed transactionally to CockroachDB."*

**👉 Scroll slowly through the trace so the judges can read the agent reasoning steps.**

---

## [1:10 – 1:40] — COCKROACHDB MEMORY LAYER

**What to do:**
1. Click **"Strategy Memory"** in the left navigation menu

> 🎙️ *"CockroachDB is not just the database — it is the brain of the system."*

> 🎙️ *"Four memory layers: VECTOR(1024) embeddings with C-SPANN indexing for RAG similarity search. Transactional JSONB state for crash resilience. Change Data Capture streaming every event in real time. And the CockroachDB Cloud MCP Server for live cluster diagnostics."*

**👉 Show the strategy table — point to the win rates and vector match scores. Note: `ecs_service_restart` shows 74% win rate (above the 70% autonomous threshold). `db_connection_pool_reset` shows ~50% (below threshold — routes to human approval).**

2. Click **"Calibration"** in the left navigation menu

> 🎙️ *"After every incident, the Auditor agent recalibrates the win rates. If the predicted outcome deviates from reality by more than 15%, the correction factor is automatically adjusted. The system gets smarter with every incident it handles."*

**👉 Show the calibration chart or table briefly.**

---

## [1:40 – 2:05] — SCENARIO B: CRASH RESILIENCE

**What to do:**
1. Go back to the **Controls panel** (right side)
2. Set the **Scenario** dropdown to → `"ECS service checkout: payment 5xx spike"` (same as before)
3. Set the **Chaos Engineering** dropdown to → `"SIGKILL crash after diagnostic"`
4. Click **"Trigger Agent"**

> 🎙️ *"Now, a crash resilience demo. We trigger a new incident — but this time with chaos mode: the server will be killed mid-repair."*

5. Immediately go to **"Live Diagnostic"** in the left nav
6. Watch the incident reach **REPAIRING** status
7. Go back to the Controls panel → scroll down to **System Ops** section → click **"SIGKILL API Server"**

> 🎙️ *"We just killed the server in the middle of a repair — exactly like a production crash."*

8. Watch the **"API Online"** dot turn red briefly, then go green again (server auto-restarts in ~5 seconds)
9. Watch the incident resume and complete — **it picks up exactly where it stopped**

> 🎙️ *"On reconnection, the agent resumes exactly where it left off. No state lost. No double execution. This is possible because every agent thought is committed to CockroachDB in a SERIALIZABLE transaction before any AWS action is taken."*

---

## [2:05 – 2:20] — IMPACT & AWS SERVICES

**What to do:**
1. Click **"Impact & Cost"** in the left navigation menu

> 🎙️ *"Cloud-Surgeon runs on: Amazon Bedrock with Mistral Large 3 for agent reasoning, with Nova Lite as automatic fallback. AWS ECS Fargate as the live repair target. CloudWatch and SNS for alert ingestion. RDS and Lambda as additional remediation surfaces."*

**👉 Let the metrics panel show — point to MTTR reduction and resolved incident count.**

---

## [2:20 – 2:30] — CLOSING

**What to do:**
1. Click **"All Incidents"** in the left navigation menu — show the full incident list

> 🎙️ *"Cloud-Surgeon: 80% reduction in mean time to repair. Zero human intervention for high-confidence incidents. A memory that grows stronger with every incident it handles."*

> 🎙️ *"CockroachDB × AWS — infrastructure that never sleeps."*

**👉 Hold on the incident list for the last 5 seconds. End recording.**

---

## SUMMARY: EVERYTHING IS DONE IN THE DASHBOARD

| Action | How |
|---|---|
| Trigger an incident | Controls panel (right) → Trigger Incident → select scenario → click "Trigger Agent" |
| Simulate a CloudWatch alarm | Controls panel (right) → CloudWatch Webhook → fill Alarm Name → click "Simulate Webhook" |
| Inject a predictive anomaly | Controls panel (right) → Predictive Injection → select scenario → click "Ingest Anomaly Metric" |
| Kill the server (chaos) | Controls panel (right) → System Ops → click "SIGKILL API Server" |
| Watch real-time agent logs | Live Diagnostic page → CDC Audit Stream (bottom of page) |
| **No terminal needed** | All actions are triggered through the dashboard UI |

---

## HACKATHON CHECKLIST

| Required | Covered | Timestamp |
|---|---|---|
| CockroachDB Distributed Vector Indexing | ✅ | 1:10 — Strategy Memory, C-SPANN, win rates |
| CockroachDB MCP Server | ✅ | 1:10 — live cluster diagnostics via MCP |
| CDC / Change Data Capture | ✅ | 0:22 — CDC Audit Stream scrolling in real time |
| AWS Bedrock (Mistral Large 3) | ✅ | 2:05 |
| AWS ECS / Lambda / RDS | ✅ | 2:05 |
| CloudWatch + SNS | ✅ | 2:05 |
| App running on its target device (web) | ✅ | entire video |
| CockroachDB memory layer visible | ✅ | 1:10 — Strategy Memory + Calibration |
| Crash resilience demo | ✅ | 1:40 — SIGKILL + resume |

---

## RECORDING TIPS

- **Recommended tool:** OBS Studio (free, Windows/Mac/Linux), QuickTime (Mac), or Xbox Game Bar (Windows)
- **Resolution:** 1920×1080 minimum
- **Speak slowly** — 2:30 fills up fast, don't rush the clicks
- **Wait 1–2 seconds after each click** before narrating, so the UI change is visible
- **Mute the browser tab sound** if you have the sound notifications enabled (bottom of left nav)
- **YouTube upload:** "Unlisted" mode is sufficient — accessible by link without a Google account
- **No background music** unless you own the rights — silence or original music only per the rules

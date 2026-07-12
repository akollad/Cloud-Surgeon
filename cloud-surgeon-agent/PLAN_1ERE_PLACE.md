# 1-Month Plan — Targeting First Place (CockroachDB x AWS 2026)
*(v3 — revised: deeper originality, explicit coverage of all 5 criteria, Bedrock removed from critical path, + 7 targeted reinforcements on weak points: quantified impact, real cost, anti-injection security, expanded chaos engineering, confidence calibration, human→memory loop, multi-cloud/multi-tenant vision)*

## Why this revision
v1 had only one originality (the "active" memory) developed enough;
the two other angles (multi-agents, node failure) were sketched, not
fully thought through, and the document did not explicitly show how
each week serves each of the 5 criteria. This version fixes both:
a single originality but pushed to its fullest, technically precise, and an
explicit criterion → deliverable mapping so that none of the 5 is left implicit.

Bedrock is removed from blocking tasks: the team handles it separately.
The plan is designed so everything else progresses independently, and so
the Bedrock connection plugs in cleanly as soon as it is ready (see
"Bedrock integration point" at the end of the document).

---

## The core originality, fully developed: "an agent that is not just resilient — its memory is too, and it learns"

The problem with the previous positioning: "confidence gating + multi-agents +
node failure" sounded like three juxtaposed features. The fully-developed version
unifies them into **a single coherent three-layer mechanism**, each layer
depending on the previous — it is no longer a list of features, it is an
architecture.

### Layer 1 — Causal and evaluated memory (not just "similar")
Today, RAG returns "the closest incident" by cosine distance, period.
Pushed to the fullest:
- Each stored vector carries the **resolution strategy used** and its
  **actual outcome** (success/failure, resolution time, number of turns).
- A SQL aggregation query computes, for each incident type, a
  **per-strategy success rate** — a contextual bandit entirely backed
  by CockroachDB (`SELECT strategy_name, count(*) FILTER (WHERE outcome_success) * 1.0 / count(*) AS win_rate ...`),
  with no external ML service.
- Incidents are causally chained (`caused_by_incident_id`,
  self-reference): an incident B caused by side effects of repairing A
  is found by a **recursive CTE** (`WITH RECURSIVE`),
  something neither a simple vector store nor a non-relational database can do
  as naturally — this is a typically CockroachDB/SQL use case that no
  competitor using Pinecone/Chroma can claim.
- **Reinforcement — confidence calibration**: the win-rate is not used
  one-shot. A periodic task compares, for each strategy, the win-rate
  *predicted at decision time* and the win-rate *actually observed since*; if
  the gap exceeds a threshold, the strategy is automatically demoted
  (less weight in layer 2) even if its raw historical win-rate remains high.
  This proves that the memory self-corrects, not just that it accumulates.

### Layer 2 — Memory decides, it does not just display
The similarity score + success rate from layer 1 drives a real
decision branch:
- **Strong score + historically reliable strategy (>80% success)** →
  immediate autonomous execution.
- **Medium score or unreliable strategy** → plan proposed, execution deferred
  until human approval (visible on the dashboard).
- **No match / strategy never attempted** → exploratory mode: more
  diagnostic turns before any corrective action, and the new strategy
  attempted is explicitly marked "experimental" in the database.
Each outcome (success/failure) feeds back into layer 1 — closed loop,
real learning on real incidents, not a one-shot.

### Layer 3 — The coordination itself goes through CockroachDB, and survives its failure
Three specialized agents (Diagnostician, Remediator, Auditor) take turns on
the same incident via **serializable CockroachDB transactions**
(claim via `UPDATE ... WHERE claimed_by_agent IS NULL RETURNING *`,
automatic retry on serialization conflict) — the database is
literally the arbiter of who has the right to act. In a live demo, we kill a
CockroachDB cluster node **during** incident processing by these agents:
the current claim, the causal history, and the strategy statistics remain
readable and consistent because CockroachDB replicates and achieves consensus
at the data level — not because the agent code has a homemade retry mechanism.

**The final narrative, in one sentence**: *"Our agent does not just learn
from past incidents — it statistically computes which strategies work,
coordinates with other agents via real transactions, and this entire
decision apparatus keeps working even when part of the database that powers
it is unplugged."* This is directly the answer to "why CockroachDB and not
Postgres+pgvector?", and it is exactly the "insight into what makes agentic
systems different" angle that the Creativity criterion explicitly asks for.

---

## Criterion mapping — no criterion left behind

| Criterion | What serves it in this plan | Week |
|---|---|---|
| **Agentic Memory Design** | Layer 1 (causal + evaluated memory); realistic volume tested (hundreds of synthetic + real incidents, not 3 demo rows) | W1-W2 |
| **Technical Implementation** | Serializable transactions (layer 3), recursive CTE (layer 1), MCP Server, ccloud/Cloud API integration already real, clean concurrency conflict handling | W1-W3 |
| **Real-World Impact** | Real ingestion from an external alert source (AWS CloudWatch Alarm -> SNS -> webhook), 5+ distinct incident scenarios, "human approval" mode that reflects a real operational need for graduated trust | W1, W3 |
| **Production Readiness** | Rate limiting, automated tests incl. crash test in CI, observability (latency, autonomy rate, win-rate by strategy), real deployment, security review, service account least privilege | W3 |
| **Creativity & Originality** | The 3-layer architecture as a whole — this is the demo climax, not a side feature | W2, presented W4 |

---

## Week 1 — Foundations: real ingestion + varied scenarios + extended schema
- [ ] Extend the schema (already started): `incident_vectors.strategy_name` /
      `outcome_success` / `incident_id`, `incident_state.caused_by_incident_id`
      / `claimed_by_agent`, new `agent_handoffs` table.
- [ ] Real entry point: webhook endpoint that accepts an AWS CloudWatch/SNS alarm
      format (not just a free-form `alertText` sent manually) — proof that it
      integrates into a real ops pipeline.
- [ ] 5-6 distinct incident scenarios with realistic error signatures (memory
      leak, saturated connection pool, cross-region latency, expired AWS
      credential, full disk, external dependency down) to feed a real knowledge
      base, not a single use case.
- [ ] Replace the simulated AWS action with a real non-destructive action
      (reading real state) to prove AWS integration without risk.

## Week 2 — Building the 3-layer architecture
- [ ] Layer 1: per-strategy win-rate aggregation queries + recursive causal
      chaining CTE, exposed and tested.
- [ ] Layer 2: confidence-based routing (autonomous / approval / exploratory mode)
      wired to layer 1 results, with systematic re-injection of each incident's outcome.
- [ ] Layer 3: the 3 specialized agents + transactional claiming
      (serialization conflict handling with retry), journaled in `agent_handoffs`.
- [ ] CockroachDB node/region failure script under controlled conditions,
      with automated verification that state remains consistent during the partial failure.
- [ ] Dashboard: "why this decision" view (similarity score, win-rate of the
      chosen strategy, agent in charge, cluster status).

## Week 3 — Production readiness (rigor, no creativity needed, just don't miss anything)
- [ ] Rate limiting by API key.
- [ ] Automated test suite: decision logic, full trigger→resolve flow, real
      crash resumption automated in CI (industrialize `real-crash-test.sh`),
      concurrent claiming conflicts between agents.
- [ ] Observability: latency by tool, autonomous vs. escalated resolution rate,
      win-rate distribution, CockroachDB system queries (`crdb_internal`)
      displayed to show real cluster load.
- [ ] Real deployment of the API server + end-to-end verification in production
      (auth, MCP, CockroachDB, ingestion webhook).
- [ ] Security review: secrets, input validation, CockroachDB Cloud service
      account permissions at least privilege, protection against public webhook abuse.

## Week 4 — Pitch, proof, rehearsal
- [ ] Pitch narrative built explicitly around the 3-layer architecture (see final
      sentence above), not a feature list.
- [ ] Demo video (2-3 min): one incident resolved autonomously thanks to a high
      win-rate, one causally linked incident found by recursive CTE, one visible
      multi-agent handoff, then the CockroachDB node/region failure mid-processing
      with no state loss.
- [ ] Architecture diagram (3 layers, agents, MCP, CockroachDB, AWS, ingestion
      webhook) for the README and submission.
- [ ] Timed rehearsal + anticipating the jury's most likely question:
      "why CockroachDB and not Postgres+pgvector?" — the answer lies in layer 3,
      not the vector store.
- [ ] Final cleanup, updated README, no demo showing unannounced behavior.

---

## Bedrock integration point (not on the critical path)
As soon as the Bedrock connection is ready on the team side, it plugs in without
touching the architecture: `invokeBedrockThought()` already generates the reasoning
text per turn with a transparent fallback (`thoughtSource`) — it only takes one
successful real call for `thoughtSource: "bedrock"` to show everywhere. No
dependency of layers 1-3 on Bedrock: the decision (autonomous/approval/exploratory)
and multi-agent coordination already work independently of the generated thought text.

## Prioritization if time runs short
1. Layer 3 (multi-agents + transactions) — the most differentiating, most
   "CockroachDB-native", most visually compelling in the demo.
2. Layers 1 + 2 (causal/evaluated memory + decision) — reinforces Agentic
   Memory Design and Creativity simultaneously.
3. Week 3 (production readiness) — reliable gain, low risk.
4. Live node failure demo — the most spectacular but also the riskiest on demo day;
   only attempt with everything else solid and sufficient rehearsal time.

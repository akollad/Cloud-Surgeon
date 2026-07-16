/**
 * Layer 1 and Impact Metrics
 *
 * GET /api/metrics/win-rates
 *   Success rate by resolution strategy, computed by pure SQL aggregation
 *   on `incident_vectors` — the "contextual bandit" powered by CockroachDB
 *   with no external ML service.
 *
 * GET /api/metrics/impact
 *   MTTR (Mean Time To Resolve) and estimated cost per incident, with comparison
 *   to the cost of a human on-call engineer. Cost assumptions are documented inline.
 *
 * POST /api/metrics/seed
 *   Triggers initialization of vector memory with synthetic incidents
 *   (one per known scenario). Idempotent.
 */

import { Router, type IRouter } from "express";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import {
  getAllStrategyWinRates,
  getAllCalibrationData,
  recalibrateAllStrategies,
  BASE_RU_PER_INCIDENT,
} from "../lib/cloud-surgeon";
import { seedVectorMemory } from "../lib/seed";
import { crdbMcp } from "../lib/crdbMcp";
import { ingestMetrics, type MetricDatapoint } from "../lib/anomaly";

const router: IRouter = Router();

router.use(apiKeyAuth);

// ── Win-rates (Layer 1 — contextual bandit) ───────────────────────────────

router.get("/metrics/win-rates", async (_req, res): Promise<void> => {
  const rates = await getAllStrategyWinRates();
  // Return bare array — matches OpenAPI spec / generated Zod schema
  res.json(rates);
});

// ── Impact (MTTR + cost) ──────────────────────────────────────────────────

/**
 * Documented cost assumptions:
 *
 * HUMAN BASELINE (20 min = 1,200 s MTTR)
 *   Source: Atlassian "State of Incident Management 2023" — median MTTR
 *   for a P1 cloud incident detected via alerting = 18–22 min.
 *   Cost: median SRE rate (USA) ≈ $105/h → 20 min = $35/incident.
 *   With overhead (PagerDuty, post-mortem, sleep loss) * 1.5
 *   → $52 per incident. We use $35 for the conservative estimate.
 *
 * AGENT (Cloud-Surgeon, ~10–15 s MTTR)
 *   CockroachDB Serverless: $1 per million Request Units (RU).
 *   Estimate: ~42 RU/incident (see estimateRuConsumed() in cloud-surgeon.ts).
 *   Cost: 42 RU * ($1 / 1,000,000) = $0.000042 per incident.
 *   Bedrock Claude 3.5 Sonnet (if available): ~$3/1M input tokens,
 *   ~$15/1M output tokens. Excluded here (geo-blocked in Replit demo).
 */
const HUMAN_BASELINE_MTTR_SECONDS = 1200; // 20 min
const HUMAN_BASELINE_COST_USD = 35.0;     // $ per on-call incident
const COCKROACHDB_RU_COST_USD_PER_MILLION = 1.0;

router.get("/metrics/impact", async (_req, res): Promise<void> => {
  // ── Statistiques globales ────────────────────────────────────────────────
  const globalRows = await db.execute<{
    total_incidents: string;
    incidents_resolved: string;
    incidents_failed: string;
    incidents_pending: string;
    incidents_active: string;
    mttr_avg_seconds: string | null;
    mttr_min_seconds: string | null;
    mttr_max_seconds: string | null;
    outlier_count: string;
    total_ru_consumed: string;
    avg_ru_per_incident: string | null;
    autonomous_count: string;
    pending_approval_count: string;
    exploratory_count: string;
    rejected_count: string;
  }>(sql`
    SELECT
      COUNT(*)                                                         AS total_incidents,
      COUNT(*) FILTER (WHERE status = 'RESOLVED')                      AS incidents_resolved,
      COUNT(*) FILTER (WHERE status = 'FAILED')                        AS incidents_failed,
      COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL')              AS incidents_pending,
      COUNT(*) FILTER (WHERE status NOT IN (
        'RESOLVED','FAILED','PENDING_APPROVAL'))                        AS incidents_active,

      -- MTTR in seconds — only incidents resolved within 30 min (1800 s).
      -- Incidents exceeding this threshold are stuck incidents (agent crash, server
      -- restart) whose wall-clock time includes hours of idle wait, not agent work.
      -- They are counted separately as outlier_count for transparency.
      ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE status IN ('RESOLVED','FAILED')
          AND resolved_at IS NOT NULL AND triggered_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (resolved_at - triggered_at)) <= 1800), 2) AS mttr_avg_seconds,
      ROUND(MIN(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE status IN ('RESOLVED','FAILED')
          AND resolved_at IS NOT NULL AND triggered_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (resolved_at - triggered_at)) <= 1800), 2) AS mttr_min_seconds,
      ROUND(MAX(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE status IN ('RESOLVED','FAILED')
          AND resolved_at IS NOT NULL AND triggered_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (resolved_at - triggered_at)) <= 1800), 2) AS mttr_max_seconds,
      COUNT(*) FILTER (WHERE status IN ('RESOLVED','FAILED')
          AND resolved_at IS NOT NULL AND triggered_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (resolved_at - triggered_at)) > 1800)        AS outlier_count,

      -- CockroachDB cost in RU
      COALESCE(SUM(ru_consumed), 0)                                    AS total_ru_consumed,
      ROUND(AVG(ru_consumed)
        FILTER (WHERE status = 'RESOLVED'), 2)                         AS avg_ru_per_incident,

      -- Breakdown by routing mode (Layer 2)
      COUNT(*) FILTER (WHERE context_json->>'routingMode' = 'AUTONOMOUS')        AS autonomous_count,
      COUNT(*) FILTER (WHERE context_json->>'routingMode' = 'PENDING_APPROVAL')  AS pending_approval_count,
      COUNT(*) FILTER (WHERE context_json->>'routingMode' = 'EXPLORATORY')       AS exploratory_count,
      COUNT(*) FILTER (WHERE context_json->>'routingMode' = 'REJECTED')          AS rejected_count
    FROM incident_state
  `);

  const g = globalRows.rows[0];
  const incidentsResolved = Number(g.incidents_resolved ?? 0);
  const totalRu = Number(g.total_ru_consumed ?? 0);
  const mttrAvg = g.mttr_avg_seconds != null ? Number(g.mttr_avg_seconds) : null;

  // Estimated agent cost
  const agentCostUsd = (totalRu / 1_000_000) * COCKROACHDB_RU_COST_USD_PER_MILLION;
  // Savings vs human baseline
  const humanTotalCost = incidentsResolved * HUMAN_BASELINE_COST_USD;
  const estimatedSavingsUsd = Math.max(0, humanTotalCost - agentCostUsd);

  // MTTR reduction in %
  const mttrReductionPct =
    mttrAvg != null && HUMAN_BASELINE_MTTR_SECONDS > 0
      ? Math.round(((HUMAN_BASELINE_MTTR_SECONDS - mttrAvg) / HUMAN_BASELINE_MTTR_SECONDS) * 100)
      : null;

  // ── MTTR by strategy ─────────────────────────────────────────────────────
  const byStrategyRows = await db.execute<{
    strategy_name: string;
    incident_count: string;
    mttr_avg_seconds: string;
    mttr_min_seconds: string;
    mttr_max_seconds: string;
  }>(sql`
    SELECT
      context_json->>'strategyName'                                              AS strategy_name,
      COUNT(*)                                                                   AS incident_count,
      ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE EXTRACT(EPOCH FROM (resolved_at - triggered_at)) <= 1800), 2) AS mttr_avg_seconds,
      ROUND(MIN(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE EXTRACT(EPOCH FROM (resolved_at - triggered_at)) <= 1800), 2) AS mttr_min_seconds,
      ROUND(MAX(EXTRACT(EPOCH FROM (resolved_at - triggered_at)))
        FILTER (WHERE EXTRACT(EPOCH FROM (resolved_at - triggered_at)) <= 1800), 2) AS mttr_max_seconds
    FROM incident_state
    WHERE status = 'RESOLVED'
      AND resolved_at IS NOT NULL
      AND triggered_at IS NOT NULL
    GROUP BY context_json->>'strategyName'
    ORDER BY mttr_avg_seconds ASC NULLS LAST
  `);

  res.json({
    // General counters
    totalIncidents: Number(g.total_incidents),
    incidentsResolved,
    incidentsFailed: Number(g.incidents_failed),
    incidentsPending: Number(g.incidents_pending),
    incidentsActive: Number(g.incidents_active),

    // Measured MTTR
    mttrStats: {
      avgSeconds: mttrAvg,
      minSeconds: g.mttr_min_seconds != null ? Number(g.mttr_min_seconds) : null,
      maxSeconds: g.mttr_max_seconds != null ? Number(g.mttr_max_seconds) : null,
      humanBaselineSeconds: HUMAN_BASELINE_MTTR_SECONDS,
      reductionPct: mttrReductionPct,
      outlierCount: Number(g.outlier_count ?? 0),
      source:
        "Real measurement (resolved_at − triggered_at) on RESOLVED/FAILED incidents. " +
        "Incidents resolved in > 30 min are excluded as stuck-incident outliers (server crash/restart) " +
        "and counted separately in outlierCount.",
    },

    // Estimated cost
    costStats: {
      totalRuConsumed: totalRu,
      avgRuPerIncident: g.avg_ru_per_incident != null ? Number(g.avg_ru_per_incident) : BASE_RU_PER_INCIDENT,
      estimatedAgentCostUsd: parseFloat(agentCostUsd.toFixed(6)),
      humanBaselineCostUsdPerIncident: HUMAN_BASELINE_COST_USD,
      humanTotalCostIfManual: parseFloat(humanTotalCost.toFixed(2)),
      estimatedSavingsUsd: parseFloat(estimatedSavingsUsd.toFixed(2)),
      cockroachdbRuPriceUsdPerMillion: COCKROACHDB_RU_COST_USD_PER_MILLION,
      hypotheses: [
        "Human MTTR baseline: 20 min (Atlassian State of Incidents 2023)",
        "On-call SRE cost: $35/incident (median US SRE rate ~$105/h * 20 min, conservative)",
        `CockroachDB Serverless: ${COCKROACHDB_RU_COST_USD_PER_MILLION}/million Request Units`,
        `Estimated RU per incident: ~${BASE_RU_PER_INCIDENT} RU (see estimateRuConsumed() in cloud-surgeon.ts)`,
        "Bedrock Sonnet 3.5 cost excluded (geo-blocked in Replit demo — include in production)",
      ],
    },

    // Breakdown by routing mode (Layer 2)
    autonomyBreakdown: {
      autonomous: Number(g.autonomous_count),
      pendingApproval: Number(g.pending_approval_count),
      exploratory: Number(g.exploratory_count),
      rejected: Number(g.rejected_count),
    },

    // MTTR by strategy
    mttrByStrategy: byStrategyRows.rows.map((r) => ({
      strategyName: r.strategy_name,
      incidentCount: Number(r.incident_count),
      mttrAvgSeconds: r.mttr_avg_seconds != null ? Number(r.mttr_avg_seconds) : null,
      mttrMinSeconds: r.mttr_min_seconds != null ? Number(r.mttr_min_seconds) : null,
      mttrMaxSeconds: r.mttr_max_seconds != null ? Number(r.mttr_max_seconds) : null,
    })),
  });
});

// ── Automatic bandit calibration (Layer 1) ───────────────────────────────

/**
 * GET /api/metrics/calibration
 *
 * Returns the calibration table per strategy: predicted win-rate (average
 * at the time of past decisions) vs actual observed win-rate (from
 * incident_vectors), correction factor, and status (calibrated/degraded/improved).
 *
 * Fully powered by CockroachDB — no external ML service.
 */
router.get("/metrics/calibration", async (_req, res): Promise<void> => {
  const calibration = await getAllCalibrationData();
  // Return bare array — matches OpenAPI spec / generated Zod schema
  res.json(calibration);
});

/**
 * POST /api/metrics/calibration/recalibrate
 *
 * Forces recomputation of the observed win-rate and correction factor for
 * all strategies recorded in strategy_calibration.
 * Useful after seeding or importing historical data.
 */
router.post("/metrics/calibration/recalibrate", async (_req, res): Promise<void> => {
  const result = await recalibrateAllStrategies();
  res.json({
    ...result,
    message: `Recalibration complete: ${result.updated} strategy(ies) updated.`,
  });
});

// ── ccloud-equivalent: CockroachDB Cloud REST API ────────────────────────
//
// GET /api/metrics/ccloud?action=cluster:status
//
// Calls the CockroachDB Cloud REST API directly — the same underlying API
// that the ccloud CLI wraps. ccloud v0.6.12 requires browser-based OAuth
// and cannot run headlessly in containers; we authenticate via the
// service-account API key. The `ccloudEquivalent` field shows the exact
// ccloud command that would produce identical output.

router.get("/metrics/ccloud", async (req, res): Promise<void> => {
  const action = String(req.query.action ?? "cluster:status");
  const apiKey = process.env.COCKROACH_CLOUD_API_KEY;
  const clusterId = process.env.COCKROACH_CLOUD_CLUSTER_ID;

  if (!apiKey || !clusterId) {
    res.status(503).json({ live: false, error: "API key or cluster ID not configured" });
    return;
  }

  const hdrs = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  const base = "https://cockroachlabs.cloud/api/v1";

  try {
    if (action === "cluster:list") {
      const r = await fetch(`${base}/clusters`, { headers: hdrs });
      const d = (await r.json()) as { clusters?: unknown[] };
      res.json({ live: true, action, clusters: d.clusters ?? [], ccloudEquivalent: "ccloud cluster list -o json" });
      return;
    }
    if (action === "cluster:sql-users") {
      const r = await fetch(`${base}/clusters/${clusterId}/sql-users`, { headers: hdrs });
      const d = (await r.json()) as { users?: unknown[] };
      res.json({ live: true, action, users: d.users ?? [], ccloudEquivalent: `ccloud cluster sql-user list ${clusterId} -o json` });
      return;
    }
    if (action === "cluster:backups") {
      const r = await fetch(`${base}/clusters/${clusterId}/backups`, { headers: hdrs });
      const d = (await r.json()) as { backups?: unknown[] };
      res.json({ live: true, action, backups: d.backups ?? [], latestBackup: (d.backups ?? [])[0] ?? null, ccloudEquivalent: `ccloud cluster backup list ${clusterId} -o json` });
      return;
    }
    // Default: cluster:status
    const r = await fetch(`${base}/clusters/${clusterId}`, { headers: hdrs });
    if (!r.ok) { res.status(r.status).json({ live: true, action, error: `CRDB Cloud API: ${r.status}` }); return; }
    const c = (await r.json()) as Record<string, unknown>;
    const regions = (c.regions as Array<Record<string, unknown>>) ?? [];
    res.json({
      live: true, action: "cluster:status",
      clusterId: c.id, clusterName: c.name, state: c.state, plan: c.plan,
      cloudProvider: c.cloud_provider, cockroachVersion: c.cockroach_version,
      upgradeStatus: c.upgrade_status,
      primaryRegion: regions.find((reg) => reg.primary)?.name ?? regions[0]?.name ?? "unknown",
      regionCount: regions.length, createdAt: c.created_at,
      summary: `Cluster '${c.name}' (${c.plan}) — state: ${c.state}, region: ${regions[0]?.name}, version: ${c.cockroach_version}`,
      ccloudEquivalent: `ccloud cluster get ${clusterId} -o json`,
      note: "ccloud v0.6.12 requires browser OAuth — Cloud-Surgeon calls the same REST API headlessly via service-account API key.",
    });
  } catch (err) {
    res.status(500).json({ live: false, action, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── CockroachDB Cluster Health (official Cloud MCP) ─────────────────────
//
// GET /api/metrics/cluster
//
// Fetches live cluster health from the official CockroachDB Cloud MCP server
// (cockroachlabs.cloud/mcp). Powers the "Cluster Health" widget in the
// Memory & Win-rates dashboard tab.
//
// Sources:
//   - `get_cluster`             → state, plan, regions
//   - `show_running_queries`    → active connection count
//
// When COCKROACH_CLOUD_API_KEY is absent, returns a simulated response so the
// dashboard renders gracefully without crashing.

router.get("/metrics/cluster", async (_req, res): Promise<void> => {
  if (!crdbMcp.isConfigured) {
    res.json({
      simulated: true,
      note: "COCKROACH_CLOUD_API_KEY not configured — set it to enable live cluster health.",
      source: "cockroachdb-cloud-mcp",
      fetchedAt: new Date().toISOString(),
    });
    return;
  }

  try {
    const health = await crdbMcp.clusterHealth();
    res.json(health);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      source: "cockroachdb-cloud-mcp",
    });
  }
});

// ── Proactive metric ingest (anomaly detection) ───────────────────────────
//
// POST /api/metrics/ingest
//
// Accepts a JSON array of CloudWatch metric datapoints. For each datapoint:
//   1. Generates an embedding for a natural-language metric description.
//   2. Runs a vector similarity search against `incident_vectors`.
//   3. Falls back to keyword pattern matching (reliable with pseudo-embeddings).
//   4. Stores the snapshot in `metric_snapshots`.
//   5. When a known failure pattern is detected BEFORE an alarm fires,
//      opens a PREDICTIVE incident tagged with source: "predictive".
//
// This is the core proactive anomaly detection feature: CockroachDB's
// distributed vector index is used not just to answer queries but to
// *watch* the environment in real time.
//
// Example payload:
//   [{ "metricName": "CPUUtilization", "value": 84,
//      "dimensions": { "ServiceName": "checkout" } }]

router.post("/metrics/ingest", async (req, res): Promise<void> => {
  const raw = req.body;
  const datapoints: MetricDatapoint[] = Array.isArray(raw)
    ? raw
    : raw?.datapoints && Array.isArray(raw.datapoints)
      ? raw.datapoints
      : null;

  if (!datapoints) {
    res.status(400).json({
      error:
        "Body must be a JSON array of metric datapoints, or an object with a 'datapoints' array. " +
        "Each item: { metricName: string, value: number, dimensions?: Record<string,string>, serviceHint?: string }",
    });
    return;
  }

  if (datapoints.length === 0) {
    res.json({ ingested: 0, predictiveIncidents: [], message: "No datapoints provided." });
    return;
  }

  if (datapoints.length > 50) {
    res.status(400).json({ error: "Maximum 50 datapoints per request." });
    return;
  }

  try {
    const result = await ingestMetrics(datapoints);
    res.json({
      ...result,
      message:
        result.predictiveIncidents.length > 0
          ? `🔮 ${result.predictiveIncidents.length} predictive incident(s) opened — agent acting before CloudWatch alarms fire.`
          : `${result.ingested} metric(s) ingested. No anomaly threshold crossed.`,
      note:
        "Proactive anomaly detection: CockroachDB vector similarity detects failure patterns " +
        "before CloudWatch fires an alarm. Predictive incidents are tagged with source='predictive'.",
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Seed ──────────────────────────────────────────────────────────────────

router.post("/metrics/seed", async (req, res): Promise<void> => {
  const force = req.query.force === "true" || req.body?.force === true;
  const result = await seedVectorMemory(force);
  res.json(result);
});

// ── Playbooks (AI-generated repair runbooks) ──────────────────────────────
//
// Returns the playbooks stored by generateAndStorePlaybook() after each
// resolved incident. Each playbook is a Markdown document synthesised from
// the agent's own turn history — not a human-written template.
// Ordered by most recent first (limit 50).

router.get("/metrics/playbooks", async (_req, res): Promise<void> => {
  try {
    const rows = await db.execute<{
      playbook_id: string;
      incident_id: string;
      strategy_name: string;
      title: string;
      content_md: string;
      generated_by: string;
      created_at: string;
    }>(sql`
      SELECT playbook_id, incident_id, strategy_name, title, content_md, generated_by, created_at
      FROM   playbooks
      ORDER  BY created_at DESC
      LIMIT  50
    `);
    res.json({
      count: rows.rows.length,
      playbooks: rows.rows.map((r) => ({
        playbookId: r.playbook_id,
        incidentId: r.incident_id,
        strategyName: r.strategy_name,
        title: r.title,
        contentMd: r.content_md,
        generatedBy: r.generated_by,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── ccloud binary smoke-test ───────────────────────────────────────────────
// GET /api/metrics/ccloud-binary-test
//   Directly executes the ccloud binary (Layer 1) — no REST fallback.
//   Returns cliMode:"ccloud_binary" + data on success (when authenticated via
//   POST /api/setup/ccloud-auth), or an error with setup instructions on failure.
//   Use this endpoint to demonstrate the two-layer architecture to hackathon judges.
import { CCLOUD_BINARY as CCLOUD_BINARY_PATH } from "../lib/ccloud-path";

router.get("/metrics/ccloud-binary-test", async (_req, res): Promise<void> => {
  const execFileAsync2 = promisify(execFile);
  const started = Date.now();

  // First: version check (always works — no auth needed)
  let version = "unknown";
  try {
    const { stdout } = await execFileAsync2(CCLOUD_BINARY_PATH, ["version"], { timeout: 5_000 });
    version = stdout.trim().split("\n")[0] ?? "unknown";
  } catch { /* binary missing */ }

  try {
    const { stdout, stderr } = await execFileAsync2(
      CCLOUD_BINARY_PATH,
      ["cluster", "list", "-o", "json"],
      {
        env: { ...process.env, HOME: process.env.HOME ?? "/home/runner" },
        timeout: 15_000,
      },
    );
    let parsed: unknown = null;
    try { parsed = JSON.parse(stdout.trim()); } catch { /* raw output */ }
    res.json({
      ok: true,
      cliMode: "ccloud_binary",
      version,
      binaryPath: CCLOUD_BINARY_PATH,
      durationMs: Date.now() - started,
      data: parsed,
      stdout: stdout.trim().slice(0, 500),
      stderr: stderr.trim().slice(0, 200) || undefined,
      note: "Layer 1 active — real ccloud binary executed successfully",
    });
  } catch (err: unknown) {
    const e = err as { code?: string; stdout?: string; stderr?: string; message?: string };
    const stderr = (e.stderr ?? e.message ?? String(err)).trim();
    const notAuthenticated = stderr.toLowerCase().includes("not logged in");
    res.status(notAuthenticated ? 401 : 500).json({
      ok: false,
      cliMode: e.code === "ENOENT" ? "binary_missing" : "auth_required",
      version,
      binaryPath: CCLOUD_BINARY_PATH,
      durationMs: Date.now() - started,
      stderr: stderr.slice(0, 300),
      note: notAuthenticated
        ? "ccloud binary found but not authenticated. POST /api/setup/ccloud-auth to complete the one-time --no-redirect browser login. Once done, this endpoint returns cliMode:ccloud_binary."
        : "ccloud binary not found at expected path",
      setup: "POST /api/setup/ccloud-auth  →  visit the returned URL  →  POST /api/setup/ccloud-auth/complete with { code }",
    });
  }
});

export default router;

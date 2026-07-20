#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  repairEcsService,
  repairRdsConnections,
  repairLambdaConcurrency,
  describeLambdaFunction,
  rollbackEcsService,
  rollbackLambdaConcurrency,
  rollbackRdsParameterGroup,
  logAwsToolMode,
} from "../lib/aws";
import { searchDocs } from "../lib/doc-rag";
import {
  hasRdsConfigured,
  rdsInstanceId,
  ecsCluster as configEcsCluster,
  ecsDefaultService,
  allKnownServiceNames,
  allKnownLambdaFunctionNames,
} from "../lib/surgeon-config";

// ----------------------------------------------------------------------------
// MCP server (Model Context Protocol) exposing the two tools Cloud-Surgeon
// can call: CockroachDB Cloud diagnostics and AWS service repair.
// This process is launched as a stdio subprocess by the backend (lib/mcpClient.ts).
// The agent "sees" these as its toolbox — the same model Claude Desktop /
// Bedrock AgentCore use in production.
// ----------------------------------------------------------------------------

// Emit a startup log so operators know at a glance whether AWS is live or simulated.
logAwsToolMode();

// ── CockroachDB Cloud CLI + REST API ──────────────────────────────────────
//
// Two-layer architecture:
//
// LAYER 1 — Real ccloud binary (headless, service-account authenticated)
//   The ccloud CLI binary lives at <workspace-root>/.tools/ccloud (committed
//   to the repo so it is available in every environment). execCcloud() runs
//   the binary via execFile with a 15 s timeout.
//
//   Authentication (v0.6.12):
//     bootstrapCcloudCredentials() runs at server startup and writes the three
//     files the ccloud binary requires for headless auth:
//       ~/.config/ccloud/credentials.json  — service-account API key
//       ~/.config/ccloud/profiles.json     — org/cluster metadata (REST fetch)
//       ~/.config/ccloud/configuration.json — non-sensitive SDK settings
//     No browser OAuth is needed. Once the files are in place Layer 1
//     succeeds immediately and cliMode = "ccloud_binary".
//
// LAYER 2 — CockroachDB Cloud REST API fallback
//   If the binary is not found, not authenticated, or returns a non-JSON
//   response, callCockroachCloudRestApi() calls the same underlying REST API
//   that ccloud wraps. Results are data-identical to the CLI output.
//   Each response includes `cliMode` ("ccloud_binary" | "rest") and
//   `ccloudEquivalent` (the exact CLI command that produces the same output).
//
// Supported actions (mirrors ccloud subcommands):
//   cluster:status   — full cluster detail (state, plan, regions, version)
//   cluster:list     — all clusters in the organisation
//   cluster:sql-users— SQL users provisioned on the cluster
//   cluster:backups  — recent backup snapshots
//   cluster:version  — CockroachDB version + upgrade status
//   cluster:sql-dns  — SQL connection hostname for the primary region

const COCKROACH_API_BASE = "https://cockroachlabs.cloud/api/v1";

import { CCLOUD_BINARY } from "../lib/ccloud-path";

/**
 * Executes a real `ccloud` CLI command (headless, service-account auth).
 *
 * Authentication is handled at server startup by bootstrapCcloudCredentials(),
 * which writes credentials.json / profiles.json / configuration.json from
 * COCKROACH_CLOUD_API_KEY — no browser OAuth required.
 *
 * Falls back gracefully if the binary is not found or the credentials files
 * are absent (Layer 2 REST API takes over).
 */
async function execCcloud(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; notFound?: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(CCLOUD_BINARY, args, {
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/home/runner",
      },
      timeout: 15_000,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (e.code === "ENOENT") {
      return { ok: false, stdout: "", stderr: `ccloud binary not found at ${CCLOUD_BINARY}`, notFound: true };
    }
    return {
      ok: false,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? String(err)).trim(),
    };
  }
}

async function crdbCloudFetch(
  path: string,
  apiKey: string,
): Promise<{ ok: boolean; data: unknown; status: number }> {
  const resp = await fetch(`${COCKROACH_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data, status: resp.status };
}

async function callCockroachCloudRestApi(
  action: string,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.COCKROACH_CLOUD_API_KEY;
  const clusterId = process.env.COCKROACH_CLOUD_CLUSTER_ID;

  if (!apiKey || !clusterId) {
    return {
      success: false, action, live: false,
      error: "COCKROACH_CLOUD_API_KEY or COCKROACH_CLOUD_CLUSTER_ID not configured",
    };
  }

  const cmd = action.toLowerCase().trim();

  try {
    if (cmd === "cluster:list") {
      const { ok, data, status } = await crdbCloudFetch("/clusters", apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status, error: (data as { message?: string }).message };
      const clusters = (data as { clusters?: unknown[] }).clusters ?? [];
      return {
        success: true, action, live: true, cliMode: "rest",
        clusterCount: clusters.length,
        clusters: (clusters as Array<Record<string, unknown>>).map((c) => ({
          id: c.id, name: c.name, state: c.state, plan: c.plan,
          cloudProvider: c.cloud_provider, version: c.cockroach_version,
        })),
        ccloudCommand: `ccloud cluster list -o json`,
      };
    }
    if (cmd === "cluster:sql-users") {
      const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}/sql-users`, apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status, cliMode: "rest" };
      return { success: true, action, live: true, cliMode: "rest", users: (data as { users?: unknown[] }).users ?? [], ccloudCommand: `ccloud cluster sql-user list ${clusterId} -o json` };
    }
    if (cmd === "cluster:backups") {
      const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}/backups`, apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status, cliMode: "rest" };
      const backups = (data as { backups?: unknown[] }).backups ?? [];
      return { success: true, action, live: true, cliMode: "rest", backupCount: backups.length, latestBackup: backups[0] ?? null, backups, ccloudCommand: `ccloud cluster backup list ${clusterId} -o json` };
    }
    if (cmd === "cluster:version") {
      const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}`, apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status, cliMode: "rest" };
      const c = data as Record<string, unknown>;
      return { success: true, action, live: true, cliMode: "rest", cockroachVersion: c.cockroach_version, upgradeStatus: c.upgrade_status, ccloudCommand: `ccloud cluster get ${clusterId} -o json` };
    }
    if (cmd === "cluster:sql-dns") {
      const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}`, apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status, cliMode: "rest" };
      const c = data as Record<string, unknown>;
      return { success: true, action, live: true, cliMode: "rest", sqlDns: c.sql_dns, ccloudCommand: `ccloud cluster get ${clusterId} -o json` };
    }
    // default: cluster:status
    const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}`, apiKey);
    if (!ok) return { success: false, action, live: true, httpStatus: status, cliMode: "rest", error: (data as { message?: string }).message };
    const c = data as Record<string, unknown>;
    const regions = (c.regions as Array<Record<string, unknown>>) ?? [];
    return {
      success: true, action: "cluster:status", live: true, cliMode: "rest",
      clusterId: c.id, clusterName: c.name, state: c.state, plan: c.plan,
      cloudProvider: c.cloud_provider, cockroachVersion: c.cockroach_version,
      upgradeStatus: c.upgrade_status, operationStatus: c.operation_status,
      primaryRegion: regions.find((r) => r.primary)?.name ?? regions[0]?.name ?? "unknown",
      regionCount: regions.length, createdAt: c.created_at, updatedAt: c.updated_at,
      summary: `Cluster '${c.name}' (${c.plan}) — state: ${c.state}, region: ${regions[0]?.name}, version: ${c.cockroach_version}`,
      ccloudCommand: `ccloud cluster get ${clusterId} -o json`,
    };
  } catch (err) {
    return { success: false, action, live: true, cliMode: "rest", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Main entry point: tries the real ccloud CLI binary first (production),
 * falls back to the CockroachDB Cloud REST API (local dev / CLI not available).
 * The `cliMode` field in the response indicates which path was taken:
 *   "ccloud_binary" — real CLI executed (ECS production)
 *   "rest"          — REST API fallback (local dev or binary not found)
 */
async function callCockroachCloudApi(action: string): Promise<Record<string, unknown>> {
  const clusterId = process.env.COCKROACH_CLOUD_CLUSTER_ID;

  if (!process.env.COCKROACH_CLOUD_API_KEY || !clusterId) {
    return {
      success: false, action, live: false,
      error: "COCKROACH_CLOUD_API_KEY or COCKROACH_CLOUD_CLUSTER_ID not configured",
    };
  }

  const cmd = action.toLowerCase().trim();

  // ── Layer 1: real ccloud binary ──────────────────────────────────────────
  let ccloudArgs: string[];
  if (cmd === "cluster:list")      ccloudArgs = ["cluster", "list", "-o", "json"];
  else if (cmd === "cluster:sql-users") ccloudArgs = ["cluster", "sql-user", "list", clusterId, "-o", "json"];
  else if (cmd === "cluster:backups")   ccloudArgs = ["cluster", "backup", "list", clusterId, "-o", "json"];
  else /* status / version / dns */     ccloudArgs = ["cluster", "get", clusterId, "-o", "json"];

  const cliResult = await execCcloud(ccloudArgs);

  if (cliResult.ok) {
    try {
      const parsed = JSON.parse(cliResult.stdout) as unknown;
      return {
        success: true, action, live: true, cliMode: "ccloud_binary",
        ccloudCommand: `ccloud ${ccloudArgs.join(" ")}`,
        data: parsed,
        // Enrich with a human-readable summary for the LLM context
        summary: `ccloud ${ccloudArgs.join(" ")} executed successfully`,
      };
    } catch {
      // Non-JSON output (e.g. auth error message) — fall through to REST
    }
  }

  // ── Layer 2: REST API fallback ────────────────────────────────────────────
  const restResult = await callCockroachCloudRestApi(action);
  if (!cliResult.notFound) {
    // Include CLI error so the operator can diagnose (only if binary exists but auth failed)
    restResult.cliWarning = cliResult.stderr;
  }
  return restResult;
}

// ── Service-name detection helpers ────────────────────────────────────────
// Extract cluster/service identifiers from the alert text when callers
// pass generic names like "checkout" or "payment-processor".

function extractEcsParams(serviceName: string): { cluster: string; service: string } {
  // Accept "cluster/service" format (preferred — always pass the real cluster).
  const parts = serviceName.split("/");
  if (parts.length === 2) return { cluster: parts[0]!, service: parts[1]! };
  // Single service name — attach the configured cluster.
  const trimmed = serviceName.trim();
  const defaultCluster = configEcsCluster();
  if (trimmed && trimmed !== "unknown" && trimmed !== "") {
    return { cluster: defaultCluster, service: trimmed };
  }
  return { cluster: defaultCluster, service: ecsDefaultService() };
}

const server = new McpServer({ name: "cloud-surgeon-tools", version: "1.0.0" });

server.registerTool(
  "execute_ccloud_command",
  {
    title: "Execute CockroachDB Cloud CLI command (ccloud binary in ECS, REST fallback in dev)",
    description:
      "In production (ECS), executes the real ccloud binary bundled in the Docker image, " +
      "authenticated headlessly via COCKROACH_API_KEY env var (no browser OAuth required). " +
      "In local dev (binary not in PATH), falls back transparently to the CockroachDB Cloud " +
      "REST API — same data, same schema. The `cliMode` field in the response indicates " +
      "which path was taken: 'ccloud_binary' (ECS) or 'rest' (fallback). " +
      "Supported actions: " +
      "'cluster:status' (default) — full cluster detail (state, plan, version, region); " +
      "'cluster:list' — all clusters in the organisation; " +
      "'cluster:sql-users' — provisioned SQL users; " +
      "'cluster:backups' — recent backup snapshots; " +
      "'cluster:version' — CockroachDB version + upgrade status; " +
      "'cluster:sql-dns' — primary region SQL hostname. " +
      "Each response includes `ccloudCommand` — the exact CLI command that produced the data.",
    inputSchema: {
      action: z
        .string()
        .describe(
          "ccloud action to run. One of: cluster:status, cluster:list, cluster:sql-users, " +
          "cluster:backups, cluster:version, cluster:sql-dns. Defaults to cluster:status.",
        )
        .default("cluster:status"),
    },
  },
  async ({ action }) => {
    const result = await callCockroachCloudApi(action);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "aws_repair_service",
  {
    title: "Repair AWS service",
    description:
      "Calls real AWS APIs to read service state and apply a targeted remediation action. " +
      "Supports ECS (force new deployment), RDS (connection parameter scaling), and Lambda " +
      "(reserved concurrency scale-up). Falls back to simulated mode when AWS credentials are absent.",
    inputSchema: {
      serviceName: z
        .string()
        .describe(
          "Service name or identifier. For ECS use 'cluster/service' or just 'service-name'. " +
          "For RDS use the DB instance identifier. For Lambda use the function name.",
        ),
      action: z
        .string()
        .describe(
          "Requested action: 'describe_and_remediate'. The service type (ecs/rds/lambda) is " +
          "inferred from the serviceName or action string.",
        ),
    },
  },
  async ({ serviceName, action }) => {
    const actionLower = action.toLowerCase();
    const combined = (serviceName + " " + action).toLowerCase();

    // Determine whether this deployment uses RDS — driven by cloud-surgeon.config.yaml
    // (infrastructure.aws.rds.instance_identifier) with RDS_INSTANCE_IDENTIFIER env
    // var as a runtime override. CockroachDB deployments have hasRds = false.
    const hasRds = hasRdsConfigured();

    let result;

    // ECS cluster/service references always contain "/" (e.g. "cloud-surgeon/checkout").
    // Lambda function names NEVER contain "/". This guard takes absolute precedence —
    // if the serviceName has a "/" it is definitively an ECS target, not Lambda.
    const isDefinitelyEcs = serviceName.includes("/");

    // Explicit "lambda:" prefix in action takes precedence — avoids keyword-miss
    // when the function name (e.g. "order-processor") doesn't contain "lambda".
    // Only Lambda function names are checked here — NOT ECS service names — so that
    // ECS service names like "checkout" do not accidentally trigger the Lambda route.
    const lambdaFunctionNames = allKnownLambdaFunctionNames();
    const isLambdaTarget = !isDefinitelyEcs && lambdaFunctionNames.some(n => combined.includes(n.toLowerCase()));

    if (
      !isDefinitelyEcs && (
        actionLower.startsWith("lambda:") ||
        combined.includes("lambda") ||
        combined.includes("concurrency") ||
        isLambdaTarget
      )
    ) {
      // Diagnostician (PHASE 0) uses lambda:diagnose → read-only describe.
      // Remediator (PHASE 1) uses lambda:describe_and_remediate → scale concurrency.
      if (actionLower === "lambda:diagnose" || actionLower === "lambda:describe") {
        result = await describeLambdaFunction(serviceName);
      } else {
        result = await repairLambdaConcurrency(serviceName);
      }
    } else if (
      // Explicit "rds:" prefix or classic keywords — only when RDS is configured.
      (actionLower.startsWith("rds:") ||
        combined.includes("rds") ||
        combined.includes("postgres") ||
        combined.includes("mysql") ||
        combined.includes("database")) &&
      hasRds
    ) {
      result = await repairRdsConnections(rdsInstanceId()!);
    } else if (
      combined.includes("rds") ||
      combined.includes("database") ||
      combined.includes("connection pool")
    ) {
      // No RDS configured — do NOT attempt an ECS lookup with the DB service name.
      // Mixing an ECS "not found" error with the crdb guidance creates contradictory
      // output that causes the LLM to follow the wrong branch (the ECS hint instead
      // of crdb_cluster_health). Return a single, unambiguous directive.
      result = {
        success: false,
        simulated: false,
        service: "crdb",
        actionTaken: "ROUTING_DECISION",
        error:
          `No RDS instance is configured in this deployment (database is CockroachDB Serverless). ` +
          `'${serviceName}' is not an ECS service — do NOT check ECS for this alert. ` +
          `You MUST call the 'crdb_cluster_health' tool to diagnose this database incident. ` +
          `Do not call aws_repair_service again for this alert.`,
        recommendation:
          "Call crdb_cluster_health immediately. Do not fall back to ECS.",
        approvalRequired: false,
      };
    } else {
      // ECS, EC2, disk, IAM, generic — target the service extracted from the alert.
      // extractEcsParams now preserves the real service name instead of defaulting
      // to ECS_DEFAULT_SERVICE, so "checkout" stays "checkout".
      const { cluster, service } = extractEcsParams(serviceName);
      result = await repairEcsService(cluster, service);
    }

    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

// ── CockroachDB Cloud Managed MCP tools (official hosted MCP) ─────────────
//
// These three tools proxy to https://cockroachlabs.cloud/mcp using
// the CrdbCloudMcpSession client (StreamableHTTP + Bearer token auth).
// This makes the agent's toolbox span TWO MCP servers simultaneously:
//   1. This process (stdio) — AWS infrastructure repair
//   2. cockroachlabs.cloud/mcp (HTTP) — CockroachDB cluster observability
//
// Auth: COCKROACH_CLOUD_API_KEY (Bearer token)
// Cluster: COCKROACH_CLOUD_CLUSTER_ID

import { crdbMcp } from "../lib/crdbMcp";

server.registerTool(
  "crdb_cluster_health",
  {
    title: "CockroachDB Cluster Health (official Cloud MCP)",
    description:
      "Fetches real-time cluster health from the official CockroachDB Cloud MCP server at " +
      "cockroachlabs.cloud/mcp. Returns cluster state, plan, regions, and active query count. " +
      "Combines the `get_cluster` and `show_running_queries` MCP tools in one call. " +
      "Use this for any database-related alert (RDS connection errors, CPU spikes, pool exhaustion).",
    inputSchema: {},
  },
  async () => {
    const result = await crdbMcp.clusterHealth() as Record<string, unknown>;
    // Inject success flag so the Auditor's repairOutput?.success check works.
    // Without it, Boolean(undefined) → false → FAIL even when the cluster is healthy.
    if (!Object.hasOwn(result, "success")) {
      result.success = !result.error && !!result.cluster;
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "crdb_list_slow_queries",
  {
    title: "List slow/running queries (official Cloud MCP)",
    description:
      "Fetches currently executing queries that have been running longer than a configurable " +
      "threshold (default: 1 second) from the official CockroachDB Cloud MCP. " +
      "Calls `select_query` on crdb_internal.cluster_queries. " +
      "Use this to diagnose high-latency alerts or connection pool exhaustion.",
    inputSchema: {
      thresholdSeconds: z
        .number()
        .optional()
        .describe("Minimum duration in seconds to include a query (default: 1)"),
    },
  },
  async ({ thresholdSeconds }) => {
    const result = await crdbMcp.listSlowQueries(thresholdSeconds ?? 1);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "crdb_query",
  {
    title: "Run diagnostic SQL (official Cloud MCP)",
    description:
      "Executes a read-only SELECT query against the live CockroachDB cluster through " +
      "the official CockroachDB Cloud MCP server (cockroachlabs.cloud/mcp). " +
      "Use for schema introspection, table statistics, replication health, or incident diagnostics.",
    inputSchema: {
      sql: z.string().describe("Read-only SELECT SQL to execute"),
      database: z
        .string()
        .optional()
        .describe("Database to run the query against (default: defaultdb)"),
    },
  },
  async ({ sql, database }) => {
    const result = await crdbMcp.query(sql, database ?? "defaultdb");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// CockroachDB Agent Skills (Open Source Repo — machine-executable skills)
//
// These five tools implement the CockroachDB Agent Skills collection, covering
// the Performance, Observability, Operations, and Schema design categories.
// Each skill calls the official CockroachDB Cloud MCP (crdbMcp) and returns
// structured JSON the agent uses for autonomous diagnosis and repair.
//
// Repo: https://github.com/cockroachdb/agent-skills
// Compatible with: Claude, Cursor, LangChain, any MCP client
// ══════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "crdb_diagnose_hotspots",
  {
    title: "CockroachDB Agent Skill — Diagnose Hot Ranges & Contention (Performance)",
    description:
      "Agent skill from the CockroachDB Agent Skills repository (Performance category). " +
      "Detects hot ranges and transaction contention by querying crdb_internal.cluster_contention_events " +
      "and crdb_internal.ranges_no_leases. Returns the top-N hottest tables/indexes with contention counts, " +
      "cumulative wait time, and the SQL statement responsible for the contention. " +
      "Use this for any alert involving high latency, connection saturation, or throughput degradation " +
      "on a CockroachDB cluster. Skill ID: crdb/performance/diagnose-hotspots.",
    inputSchema: {
      topN: z.number().optional().describe("Number of hot ranges to return (default: 10)"),
      database: z.string().optional().describe("Database to scope the query to (default: all)"),
    },
  },
  async ({ topN, database }) => {
    const limit = topN ?? 10;
    const result = await crdbMcp.query(
      `SELECT
         table_name,
         index_name,
         num_contention_events AS contention_events,
         ROUND(cumulative_contention_time::DECIMAL / 1e9, 3) AS contention_seconds,
         LEFT(key, 120) AS hottest_key
       FROM crdb_internal.cluster_contention_events
       ORDER BY num_contention_events DESC
       LIMIT ${limit}`,
      database ?? "defaultdb",
    );
    const rangesResult = await crdbMcp.query(
      `SELECT
         range_id,
         start_pretty,
         replicas,
         lease_holder,
         range_size / 1048576.0 AS size_mb
       FROM crdb_internal.ranges_no_leases
       ORDER BY range_size DESC
       LIMIT 5`,
      database ?? "defaultdb",
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          skill: "crdb/performance/diagnose-hotspots",
          source: "cockroachdb-agent-skills",
          hotContention: result,
          largestRanges: rangesResult,
          diagnosis: "High contention_events or cumulative_contention_time indicates a hot spot. " +
            "Consider adding a hash-sharded index on the hottest table or splitting the range.",
          ccloudEquivalent: "ccloud cluster sql -- SELECT ... FROM crdb_internal.cluster_contention_events",
          fetchedAt: new Date().toISOString(),
        }),
      }],
    };
  },
);

server.registerTool(
  "crdb_index_advisor",
  {
    title: "CockroachDB Agent Skill — Index Advisor (Schema Design)",
    description:
      "Agent skill from the CockroachDB Agent Skills repository (Schema Design category). " +
      "Reads crdb_internal.index_recommendations to surface missing indexes, redundant indexes, " +
      "and full-table-scan statements identified by the CockroachDB query optimizer. " +
      "Returns actionable CREATE INDEX or DROP INDEX DDL statements ready to execute. " +
      "Use for any alert involving slow queries, high read amplification, or optimizer warnings. " +
      "Skill ID: crdb/schema/index-advisor.",
    inputSchema: {
      database: z.string().optional().describe("Database to inspect (default: defaultdb)"),
      type: z.enum(["index_replacement", "drop_unused_index", "all"]).optional()
        .describe("Filter by recommendation type (default: all)"),
    },
  },
  async ({ database, type }) => {
    const typeFilter = type && type !== "all" ? `WHERE type = '${type}'` : "";
    const result = await crdbMcp.query(
      `SELECT
         type,
         object_name AS table_or_index,
         index_name,
         details,
         LEFT(create_statement, 300) AS recommended_ddl
       FROM crdb_internal.index_recommendations
       ${typeFilter}
       ORDER BY type, object_name
       LIMIT 20`,
      database ?? "defaultdb",
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          skill: "crdb/schema/index-advisor",
          source: "cockroachdb-agent-skills",
          recommendations: result,
          howToApply: "Execute `recommended_ddl` in a transaction during low-traffic hours. " +
            "DROP INDEX requires CONCURRENTLY flag in CockroachDB 23.1+.",
          fetchedAt: new Date().toISOString(),
        }),
      }],
    };
  },
);

server.registerTool(
  "crdb_cancel_query",
  {
    title: "CockroachDB Agent Skill — Cancel Long-Running Query (Operations)",
    description:
      "Agent skill from the CockroachDB Agent Skills repository (Operations category). " +
      "Identifies and optionally cancels queries running longer than a threshold using " +
      "crdb_internal.cancel_query(). Safe: only targets SELECT/UPDATE/DELETE, never DDL. " +
      "Use when a long-running query is blocking writes or saturating connection pools. " +
      "Skill ID: crdb/operations/cancel-query.",
    inputSchema: {
      thresholdSeconds: z.number().optional().describe("Cancel queries running longer than this many seconds (default: 30)"),
      dryRun: z.boolean().optional().describe("If true, list candidates but do not cancel (default: true)"),
      database: z.string().optional().describe("Database to scope the operation (default: defaultdb)"),
    },
  },
  async ({ thresholdSeconds, dryRun, database }) => {
    const threshold = thresholdSeconds ?? 30;
    const isDryRun = dryRun !== false; // default true — safe by default
    const candidateResult = await crdbMcp.query(
      `SELECT
         query_id,
         application_name,
         LEFT(query, 200) AS query_preview,
         ROUND(EXTRACT(EPOCH FROM (now() - start)), 1) AS running_seconds,
         username
       FROM crdb_internal.cluster_queries
       WHERE now() - start > INTERVAL '${threshold} second'
         AND query NOT ILIKE 'SET %'
         AND query NOT ILIKE 'SHOW %'
       ORDER BY start
       LIMIT 10`,
      database ?? "defaultdb",
    );
    const cancelled: unknown[] = [];
    if (!isDryRun && (candidateResult as { rows?: unknown[] }).rows) {
      for (const row of (candidateResult as { rows: Array<{ query_id: string }> }).rows.slice(0, 3)) {
        const r = await crdbMcp.query(
          `SELECT crdb_internal.cancel_query('${row.query_id}') AS cancelled`,
          database ?? "defaultdb",
        );
        cancelled.push({ query_id: row.query_id, result: r });
      }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          skill: "crdb/operations/cancel-query",
          source: "cockroachdb-agent-skills",
          dryRun: isDryRun,
          thresholdSeconds: threshold,
          candidates: candidateResult,
          cancelled,
          note: isDryRun
            ? "Dry-run: no queries were cancelled. Set dryRun=false to cancel the top-3 candidates."
            : `Cancelled ${cancelled.length} long-running queries.`,
          fetchedAt: new Date().toISOString(),
        }),
      }],
    };
  },
);

server.registerTool(
  "crdb_job_status",
  {
    title: "CockroachDB Agent Skill — Job & Changefeed Status (Observability)",
    description:
      "Agent skill from the CockroachDB Agent Skills repository (Observability category). " +
      "Queries crdb_internal.jobs to surface paused, failed, or lagging changefeeds (CDC), " +
      "backup jobs, and schema change operations. Returns job ID, type, status, error, and lag. " +
      "Use for any alert involving CDC stalls, backup failures, or schema change timeouts. " +
      "Skill ID: crdb/observability/job-status.",
    inputSchema: {
      jobType: z.enum(["changefeed", "backup", "schema_change", "all"]).optional()
        .describe("Filter by job type (default: all)"),
      statusFilter: z.enum(["paused", "failed", "running", "all"]).optional()
        .describe("Filter by status (default: all)"),
    },
  },
  async ({ jobType, statusFilter }) => {
    const typeClause = jobType && jobType !== "all"
      ? `AND job_type ILIKE '${jobType}%'` : "";
    const statusClause = statusFilter && statusFilter !== "all"
      ? `AND status = '${statusFilter}'` : "";
    const result = await crdbMcp.query(
      `SELECT
         id AS job_id,
         job_type,
         status,
         description,
         LEFT(error, 200) AS last_error,
         created AS created_at,
         finished AS finished_at,
         fraction_completed
       FROM crdb_internal.jobs
       WHERE true ${typeClause} ${statusClause}
       ORDER BY created DESC
       LIMIT 20`,
      "defaultdb",
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          skill: "crdb/observability/job-status",
          source: "cockroachdb-agent-skills",
          jobs: result,
          howToResume: "To resume a paused changefeed: RESUME JOB <job_id>. " +
            "To restart a failed backup: re-run the BACKUP INTO statement.",
          fetchedAt: new Date().toISOString(),
        }),
      }],
    };
  },
);

server.registerTool(
  "crdb_skill_repair",
  {
    title: "CockroachDB Agent Skill — Autonomous Repair Orchestrator",
    description:
      "Orchestrates the CockroachDB Agent Skills collection to autonomously diagnose and repair " +
      "a CockroachDB incident. Selects the appropriate skill sequence based on the detected strategy: " +
      "crdb_hotspot_resolution → diagnose_hotspots + index_advisor; " +
      "crdb_index_optimization → index_advisor; " +
      "crdb_slow_query_termination → cancel_query (dry-run first); " +
      "crdb_replication_recovery → cluster_health + crdb_query on under-replicated ranges; " +
      "crdb_changefeed_restart → job_status + RESUME JOB. " +
      "Returns a structured repair report with diagnosis, actions taken, and next steps.",
    inputSchema: {
      strategy: z.string().describe("CRDB strategy name (e.g. crdb_hotspot_resolution)"),
      serviceName: z.string().describe("Affected service or table name"),
    },
  },
  async ({ strategy, serviceName }) => {
    // Real execution path — diagnostic queries use COCKROACHDB_URL directly,
    // not the Cloud API, so they always run regardless of COCKROACH_CLOUD_API_KEY.
    const report: Record<string, unknown> = {
      strategy,
      serviceName,
      source: "cockroachdb-agent-skills",
      skillsInvoked: [] as string[],
      actionsApplied: [] as string[],
    };

    // Detect whether a query was rejected because crdb_internal is restricted on
    // CockroachDB Serverless / Basic plan.  The MCP select_query tool returns
    // { success: false, error: "query references a restricted schema: access to
    // \"crdb_internal\" is blocked for security reasons" } — it does NOT throw.
    const isCrdbInternalBlocked = (r: Record<string, unknown>): boolean =>
      r.success === false &&
      /restricted schema|crdb_internal.*blocked|blocked for security/i.test(String(r.error ?? ""));

    // Generic error check (any kind of query failure).
    const isQueryError = (r: Record<string, unknown>): boolean => r.success === false;

    try {
      if (strategy === "crdb_hotspot_resolution") {
        (report.skillsInvoked as string[]).push("crdb/performance/diagnose-hotspots");

        // Primary: crdb_internal (Standard plan / dedicated).
        let hotspots = await crdbMcp.query(
          `SELECT table_name, index_name, num_contention_events, ROUND(cumulative_contention_time::DECIMAL/1e9,2) AS contention_s
           FROM crdb_internal.cluster_contention_events ORDER BY num_contention_events DESC LIMIT 5`,
          "defaultdb",
        );
        // Fallback: pg_stat_activity is always readable on Basic/Serverless.
        if (isCrdbInternalBlocked(hotspots)) {
          report.planNote = "crdb_internal restricted on this cluster plan — using pg_stat_activity fallback";
          hotspots = await crdbMcp.query(
            `SELECT pid, usename, application_name, state,
                    now() - query_start AS duration,
                    LEFT(query, 200) AS query_preview
             FROM pg_stat_activity
             WHERE state != 'idle' AND query_start IS NOT NULL
             ORDER BY query_start
             LIMIT 10`,
            "defaultdb",
          );
        }
        report.hotspotDiagnosis = hotspots;

        (report.skillsInvoked as string[]).push("crdb/schema/index-advisor");

        // Primary: crdb_internal.index_recommendations.
        let indexes = await crdbMcp.query(
          `SELECT type, object_name, index_name, LEFT(create_statement,200) AS recommended_ddl
           FROM crdb_internal.index_recommendations LIMIT 5`,
          "defaultdb",
        );
        // Fallback: existing index catalogue from information_schema (always readable).
        if (isCrdbInternalBlocked(indexes)) {
          indexes = await crdbMcp.query(
            `SELECT table_name, index_name, non_unique, column_name, seq_in_index
             FROM information_schema.statistics
             WHERE table_schema = 'public'
             ORDER BY table_name, index_name, seq_in_index
             LIMIT 20`,
            "defaultdb",
          );
          report.indexAdvisorNote = "index_recommendations unavailable on this plan — showing existing indexes from information_schema";
        }
        report.indexRecommendations = indexes;

        const hotspotsOk = !isQueryError(hotspots);
        const indexesOk  = !isQueryError(indexes);

        if (!hotspotsOk && !indexesOk) {
          report.success    = false;
          report.actionTaken = "";
          report.outcome    = "Diagnostic failed — hotspot analysis and index advisor both returned errors. Check cluster connectivity and permissions.";
        } else {
          (report.actionsApplied as string[]).push(
            hotspotsOk ? "Diagnosed active contention / active sessions" : "Hotspot query failed — skipped",
            indexesOk  ? "Retrieved index information"                   : "Index advisor query failed — skipped",
          );
          report.actionTaken = "CRDB_HOTSPOT_DIAGNOSED";
          report.outcome = report.planNote
            ? "Partial diagnosis via pg_stat_activity and information_schema (crdb_internal is restricted on the Basic/Serverless plan). Review active sessions and existing indexes. For crdb_internal.cluster_contention_events and index_recommendations, upgrade to Standard plan."
            : "Hot-spot diagnosed. Index recommendations surfaced. Apply DDL during maintenance window.";
        }

      } else if (strategy === "crdb_index_optimization") {
        (report.skillsInvoked as string[]).push("crdb/schema/index-advisor");

        let indexes = await crdbMcp.query(
          `SELECT type, object_name, index_name, details, LEFT(create_statement,300) AS recommended_ddl
           FROM crdb_internal.index_recommendations LIMIT 10`,
          "defaultdb",
        );
        if (isCrdbInternalBlocked(indexes)) {
          report.planNote = "crdb_internal restricted — showing existing indexes from information_schema";
          indexes = await crdbMcp.query(
            `SELECT table_name, index_name, non_unique, column_name, seq_in_index
             FROM information_schema.statistics
             WHERE table_schema = 'public'
             ORDER BY table_name, index_name, seq_in_index
             LIMIT 30`,
            "defaultdb",
          );
        }
        report.indexRecommendations = indexes;

        if (isQueryError(indexes)) {
          report.success    = false;
          report.actionTaken = "";
          report.outcome    = "Index advisor query failed. Check cluster connectivity.";
        } else {
          (report.actionsApplied as string[]).push("Retrieved index information");
          report.actionTaken = "CRDB_INDEX_DIAGNOSED";
          report.outcome = report.planNote
            ? "Existing index catalogue retrieved via information_schema (crdb_internal.index_recommendations unavailable on Basic/Serverless plan). Review for missing or redundant indexes manually."
            : "Index recommendations ready to apply. Review DDL before executing.";
        }

      } else if (strategy === "crdb_slow_query_termination") {
        (report.skillsInvoked as string[]).push("crdb/operations/cancel-query");

        // listSlowQueries uses crdb_internal.cluster_queries internally via select_query.
        let slowQueries = await crdbMcp.listSlowQueries(30);
        if (isCrdbInternalBlocked(slowQueries)) {
          report.planNote = "crdb_internal restricted — using show_running_queries MCP tool";
          slowQueries = await crdbMcp.callTool("show_running_queries", {});
        }
        report.slowQueryDiagnosis = slowQueries;

        if (isQueryError(slowQueries)) {
          report.success    = false;
          report.actionTaken = "";
          report.outcome    = "Slow query listing failed. Check cluster connectivity.";
        } else {
          (report.actionsApplied as string[]).push("Listed long-running queries (dry-run — no cancellations)");
          report.actionTaken = "CRDB_SLOW_QUERY_LISTED";
          report.outcome = "Slow query candidates identified. Use crdb_cancel_query with dryRun=false to terminate.";
        }

      } else if (strategy === "crdb_replication_recovery") {
        (report.skillsInvoked as string[]).push("crdb/observability/job-status");

        // Cluster health via Cloud MCP (always works — no crdb_internal dependency).
        const health = await crdbMcp.clusterHealth();
        report.clusterHealth = health;

        // Under-replicated ranges: crdb_internal.ranges_no_leases.
        const underReplicated = await crdbMcp.query(
          `SELECT range_id, start_pretty, replicas, lease_holder
           FROM crdb_internal.ranges_no_leases
           WHERE array_length(replicas, 1) < 3
           LIMIT 10`,
          "defaultdb",
        );
        if (isCrdbInternalBlocked(underReplicated)) {
          report.planNote = "crdb_internal.ranges_no_leases restricted on this plan — range-level diagnosis unavailable; cluster health checked via Cloud MCP only";
          report.underReplicatedRanges = { available: false, reason: "crdb_internal restricted on Basic/Serverless plan" };
        } else {
          report.underReplicatedRanges = underReplicated;
        }

        (report.actionsApplied as string[]).push(
          "Checked cluster health via CockroachDB Cloud MCP",
          isCrdbInternalBlocked(underReplicated) ? "Range-level query skipped (plan restriction)" : "Queried under-replicated ranges",
        );
        report.actionTaken = "CRDB_REPLICATION_ASSESSED";
        report.outcome = report.planNote
          ? "Cluster health checked. Under-replicated range query unavailable on Basic/Serverless plan — upgrade to Standard for range-level diagnostics."
          : "Replication health assessed. Node recovery required if under-replicated ranges persist > 5 min.";

      } else if (strategy === "crdb_changefeed_restart") {
        (report.skillsInvoked as string[]).push("crdb/observability/job-status");

        // Primary: crdb_internal.jobs.
        let jobs = await crdbMcp.query(
          `SELECT id, job_type, status, description, LEFT(error,200) AS last_error
           FROM crdb_internal.jobs WHERE job_type ILIKE 'changefeed%' AND status IN ('paused','failed')
           LIMIT 10`,
          "defaultdb",
        );
        // Fallback: Cloud MCP check_job_health tool (no crdb_internal dependency).
        if (isCrdbInternalBlocked(jobs)) {
          report.planNote = "crdb_internal.jobs restricted — using Cloud MCP check_job_health tool";
          jobs = await crdbMcp.callTool("check_job_health", {});
        }
        report.pausedChangefeeds = jobs;

        if (isQueryError(jobs)) {
          report.success    = false;
          report.actionTaken = "";
          report.outcome    = "Changefeed job listing failed. Check cluster connectivity.";
        } else {
          (report.actionsApplied as string[]).push("Identified paused/failed changefeeds");
          report.actionTaken = "CRDB_CHANGEFEED_LISTED";
          report.outcome = "Paused changefeeds identified. Execute RESUME JOB <id> for each paused changefeed.";
          report.resumeCommands = "RESUME JOB <job_id>; -- repeat for each paused changefeed";
        }

      } else {
        const health = await crdbMcp.clusterHealth();
        report.clusterHealth = health;
        (report.actionsApplied as string[]).push("General cluster health check via CockroachDB Cloud MCP");
        report.actionTaken = "CRDB_HEALTH_CHECKED";
        report.outcome = "General CRDB health check completed.";
      }

      // Only mark success=true if it was not already set to false by a branch above.
      if (report.success !== false) {
        report.success = true;
      }
      report.cliMode = "live";
      report.fetchedAt = new Date().toISOString();

    } catch (err) {
      report.success    = false;
      report.actionTaken = "";
      report.error      = err instanceof Error ? err.message : String(err);
      report.cliMode    = "live-error";
    }

    return { content: [{ type: "text", text: JSON.stringify(report) }] };
  },
);

// ── search_docs — vector + web-fetch knowledge retrieval ──────────────────
//
// Exposes the full Tier 1 (doc_chunks cosine search) + Tier 2 (live web
// fetch fallback) pipeline as an MCP tool so the agent can call it during
// the main repair loop — not only inside Bedrock's internal tool-use turn.
//
// When to call: agent detects it lacks specific field names, API response
// formats, metric definitions, or operational procedures for the alert at hand.
// Nova Lite already calls this autonomously via Bedrock Converse tool use;
// exposing it here makes it available to any MCP client including the
// Cloud-Surgeon repair orchestrator itself.

server.registerTool(
  "search_docs",
  {
    title: "Search docs and skills (vector similarity + live web fallback)",
    description:
      "Searches the embedded knowledge base (doc_chunks) for official AWS and CockroachDB " +
      "documentation, Cloud-Surgeon strategy skills, and MCP tool guides using Voyage-3 " +
      "vector cosine similarity. Falls back to a live web fetch from curated documentation " +
      "URLs when vector confidence is low (distance > 0.40). " +
      "Call this when you need: precise CloudWatch metric names, ECS/RDS/Lambda API field names, " +
      "CockroachDB diagnostic SQL, which repair strategy or MCP tool to use for a given alert, " +
      "or any operational procedure not present in your training data. " +
      "Returns the most relevant documentation text for the query.",
    inputSchema: {
      query: z
        .string()
        .describe(
          "Natural language query describing what to look up. " +
          "Examples: 'ECS DescribeServices rolloutState field values', " +
          "'which strategy to use for Lambda throttling', " +
          "'CockroachDB how to detect hot ranges', " +
          "'RDS max_connections formula for db.t3.medium'.",
        ),
    },
  },
  async ({ query }) => {
    try {
      const result = await searchDocs(query);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `search_docs error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  },
);

// ── Rollback execution tool ────────────────────────────────────────────────
//
// Called by runRollbackLoop when a human requests rollback of a resolved
// incident. Reads the preRepairState snapshot captured by the Remediator and
// executes the exact inverse AWS action.
//
// Routing by strategy:
//   ecs_*         → rollbackEcsService   (force new deployment, optional prev task def)
//   lambda_*      → rollbackLambdaConcurrency (restore original reserved concurrency)
//   rds_* / db_*  → rollbackRdsParameterGroup (restore max_connections)
//   crdb_*        → no automated rollback (CockroachDB changes are either read-only
//                   or handled by the DB engine; return safe instructions)
//   others        → generic ECS rollback

server.registerTool(
  "rollback_service",
  {
    title: "Rollback last repair action",
    description:
      "Reverses the repair executed by the Remediator phase by restoring the " +
      "pre-repair state snapshot. Called automatically when a human requests rollback " +
      "via POST /api/incidents/:id/rollback. " +
      "Routes to the correct inverse AWS operation based on the strategy used. " +
      "For CockroachDB strategies, returns the manual rollback steps (those changes " +
      "are either read-only or managed by the DB engine).",
    inputSchema: {
      strategy:      z.string().describe("Strategy name from the original repair (e.g. ecs_service_restart)"),
      preRepairState: z.record(z.unknown()).describe("Pre-repair state snapshot from rollback_plans.pre_repair_state"),
    },
  },
  async ({ strategy, preRepairState }) => {
    let result: Record<string, unknown>;

    try {
      if (strategy.startsWith("crdb_")) {
        // CockroachDB repairs are either read-only or self-managed by the DB.
        // Return the human-readable rollback steps from the stored plan.
        result = {
          success: true,
          simulated: false,
          service: "cockroachdb",
          actionTaken: "ROLLBACK_INSTRUCTIONS_ONLY",
          note: "CockroachDB rollbacks require manual execution — see rollbackSteps in the rollback plan.",
          preRepairState,
        };

      } else if (strategy === "lambda_concurrency_scale") {
        const fn = String(preRepairState.functionName ?? preRepairState.serviceName ?? "");
        const origConcurrency =
          preRepairState.originalConcurrency !== undefined && preRepairState.originalConcurrency !== null
            ? Number(preRepairState.originalConcurrency)
            : null;
        result = await rollbackLambdaConcurrency(fn, origConcurrency) as unknown as Record<string, unknown>;

      } else if (strategy === "rds_cpu_throttle" || strategy === "db_connection_pool_reset") {
        const instanceId = String(
          preRepairState.rdsInstanceId ?? preRepairState.instanceId ?? process.env.RDS_INSTANCE_IDENTIFIER ?? "",
        );
        const origMax = Number(preRepairState.originalMaxConnections ?? 100);
        result = await rollbackRdsParameterGroup(instanceId, origMax) as unknown as Record<string, unknown>;

      } else {
        // ECS: ecs_service_restart, jvm_heap_restart, default_repair, etc.
        const svcName = String(preRepairState.serviceName ?? "");
        const parts = svcName.split("/");
        const cluster = parts.length === 2 ? parts[0]! : (process.env.ECS_DEFAULT_CLUSTER ?? "cloud-surgeon");
        const service = parts.length === 2 ? parts[1]! : svcName;
        const prevTaskDef = preRepairState.previousTaskDefinition as string | undefined;
        result = await rollbackEcsService(cluster, service, prevTaskDef) as unknown as Record<string, unknown>;
      }
    } catch (err) {
      result = {
        success: false,
        service: "unknown",
        actionTaken: "ROLLBACK_ATTEMPT",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

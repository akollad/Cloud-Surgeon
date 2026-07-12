#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  repairEcsService,
  repairRdsConnections,
  repairLambdaConcurrency,
  logAwsToolMode,
} from "../lib/aws";

// ----------------------------------------------------------------------------
// MCP server (Model Context Protocol) exposing the two tools Cloud-Surgeon
// can call: CockroachDB Cloud diagnostics and AWS service repair.
// This process is launched as a stdio subprocess by the backend (lib/mcpClient.ts).
// The agent "sees" these as its toolbox — the same model Claude Desktop /
// Bedrock AgentCore use in production.
// ----------------------------------------------------------------------------

// Emit a startup log so operators know at a glance whether AWS is live or simulated.
logAwsToolMode();

// ── CockroachDB Cloud REST API (ccloud-equivalent) ───────────────────────
//
// ccloud v0.6.12 requires browser-based OAuth and cannot be used headlessly
// in containerised environments. Cloud-Surgeon instead calls the same
// underlying CockroachDB Cloud REST API that the ccloud binary wraps,
// authenticated with the service-account API key already available in the
// environment. This provides identical data and capabilities to ccloud.
//
// Supported actions (mirrors ccloud subcommands):
//   cluster:status      — full cluster detail (state, plan, regions, version)
//   cluster:list        — all clusters in the organisation
//   cluster:sql-users   — SQL users provisioned on the cluster
//   cluster:backups     — recent backup snapshots
//   cluster:version     — CockroachDB version + upgrade status
//   cluster:sql-dns     — SQL connection hostname for the primary region
//
// Any unknown action falls back to cluster:status.

const COCKROACH_API_BASE = "https://cockroachlabs.cloud/api/v1";

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

async function callCockroachCloudApi(action: string): Promise<Record<string, unknown>> {
  const apiKey = process.env.COCKROACH_CLOUD_API_KEY;
  const clusterId = process.env.COCKROACH_CLOUD_CLUSTER_ID;

  if (!apiKey || !clusterId) {
    return {
      success: false,
      action,
      live: false,
      error: "COCKROACH_CLOUD_API_KEY or COCKROACH_CLOUD_CLUSTER_ID not configured",
    };
  }

  const cmd = action.toLowerCase().trim();

  try {
    // ── cluster:list ───────────────────────────────────────────────────────
    if (cmd === "cluster:list") {
      const { ok, data, status } = await crdbCloudFetch("/clusters", apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status, error: (data as { message?: string }).message };
      const clusters = (data as { clusters?: unknown[] }).clusters ?? [];
      return {
        success: true, action, live: true,
        clusterCount: clusters.length,
        clusters: (clusters as Array<Record<string, unknown>>).map((c) => ({
          id: c.id, name: c.name, state: c.state, plan: c.plan,
          cloudProvider: c.cloud_provider, version: c.cockroach_version,
        })),
        ccloudEquivalent: `ccloud cluster list -o json`,
      };
    }

    // ── cluster:sql-users ──────────────────────────────────────────────────
    if (cmd === "cluster:sql-users") {
      const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}/sql-users`, apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status };
      return {
        success: true, action, live: true,
        users: (data as { users?: unknown[] }).users ?? [],
        ccloudEquivalent: `ccloud cluster sql-user list ${clusterId} -o json`,
      };
    }

    // ── cluster:backups ────────────────────────────────────────────────────
    if (cmd === "cluster:backups") {
      const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}/backups`, apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status };
      const backups = (data as { backups?: unknown[] }).backups ?? [];
      return {
        success: true, action, live: true,
        backupCount: backups.length,
        latestBackup: backups[0] ?? null,
        backups,
        ccloudEquivalent: `ccloud cluster backup list ${clusterId} -o json`,
      };
    }

    // ── cluster:version ────────────────────────────────────────────────────
    if (cmd === "cluster:version") {
      const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}`, apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status };
      const c = data as Record<string, unknown>;
      return {
        success: true, action, live: true,
        cockroachVersion: c.cockroach_version,
        upgradeStatus: c.upgrade_status,
        upgradeType: (c.config as Record<string, Record<string, unknown>>)?.serverless?.upgrade_type ?? null,
        ccloudEquivalent: `ccloud cluster get ${clusterId} -o json | jq .cockroach_version`,
      };
    }

    // ── cluster:sql-dns ────────────────────────────────────────────────────
    if (cmd === "cluster:sql-dns") {
      const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}`, apiKey);
      if (!ok) return { success: false, action, live: true, httpStatus: status };
      const c = data as Record<string, unknown>;
      return {
        success: true, action, live: true,
        sqlDns: c.sql_dns,
        routingId: (c.config as Record<string, Record<string, unknown>>)?.serverless?.routing_id ?? null,
        ccloudEquivalent: `ccloud cluster sql-user get ${clusterId} -o json`,
      };
    }

    // ── cluster:status (default) ───────────────────────────────────────────
    const { ok, data, status } = await crdbCloudFetch(`/clusters/${clusterId}`, apiKey);
    if (!ok) return { success: false, action, live: true, httpStatus: status, error: (data as { message?: string }).message };
    const c = data as Record<string, unknown>;
    const regions = (c.regions as Array<Record<string, unknown>>) ?? [];
    return {
      success: true,
      action: "cluster:status",
      live: true,
      clusterId: c.id,
      clusterName: c.name,
      state: c.state,
      plan: c.plan,
      cloudProvider: c.cloud_provider,
      cockroachVersion: c.cockroach_version,
      upgradeStatus: c.upgrade_status,
      operationStatus: c.operation_status,
      primaryRegion: regions.find((r) => r.primary)?.name ?? regions[0]?.name ?? "unknown",
      regionCount: regions.length,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      summary: `Cluster '${c.name}' (${c.plan}) — state: ${c.state}, region: ${regions[0]?.name}, version: ${c.cockroach_version}`,
      ccloudEquivalent: `ccloud cluster get ${clusterId} -o json`,
    };
  } catch (err) {
    return {
      success: false,
      action,
      live: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Service-name detection helpers ────────────────────────────────────────
// Extract cluster/service identifiers from the alert text when callers
// pass generic names like "checkout" or "payment-processor".

function extractEcsParams(serviceName: string): { cluster: string; service: string } {
  // Accept "cluster/service" format or default to a prod-cluster convention
  const parts = serviceName.split("/");
  if (parts.length === 2) return { cluster: parts[0]!, service: parts[1]! };
  return { cluster: process.env.ECS_DEFAULT_CLUSTER ?? "prod-cluster", service: serviceName };
}

const server = new McpServer({ name: "cloud-surgeon-tools", version: "1.0.0" });

server.registerTool(
  "execute_ccloud_command",
  {
    title: "Execute CockroachDB Cloud CLI command (via REST API)",
    description:
      "Executes a ccloud-equivalent command against the live CockroachDB Cloud REST API. " +
      "ccloud v0.6.12 requires browser-based OAuth and cannot run headlessly in containers; " +
      "Cloud-Surgeon therefore calls the same underlying REST API that ccloud wraps, " +
      "authenticated with the service-account API key. Results are identical to ccloud output. " +
      "Supported actions: " +
      "'cluster:status' (default) — full cluster detail (state, plan, version, region); " +
      "'cluster:list' — all clusters in the organisation; " +
      "'cluster:sql-users' — provisioned SQL users; " +
      "'cluster:backups' — recent backup snapshots; " +
      "'cluster:version' — CockroachDB version + upgrade status; " +
      "'cluster:sql-dns' — primary region SQL hostname. " +
      "Each result includes a 'ccloudEquivalent' field showing the exact ccloud command " +
      "that would produce the same data.",
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
    const combined = (serviceName + " " + action).toLowerCase();

    let result;

    if (combined.includes("ecs") || combined.includes("checkout") || combined.includes("task")) {
      const { cluster, service } = extractEcsParams(serviceName);
      result = await repairEcsService(cluster, service);
    } else if (
      combined.includes("rds") ||
      combined.includes("db") ||
      combined.includes("postgres") ||
      combined.includes("mysql") ||
      combined.includes("catalog") ||
      combined.includes("database")
    ) {
      result = await repairRdsConnections(serviceName);
    } else if (
      combined.includes("lambda") ||
      combined.includes("function") ||
      combined.includes("payment-processor") ||
      combined.includes("concurrency")
    ) {
      result = await repairLambdaConcurrency(serviceName);
    } else {
      // Generic fallback: try ECS first, accept whatever comes back
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
    const result = await crdbMcp.clusterHealth();
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

const transport = new StdioServerTransport();
await server.connect(transport);

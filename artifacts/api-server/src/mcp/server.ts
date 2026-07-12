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

const COCKROACH_API_BASE = "https://cockroachlabs.cloud/api/v1";

async function callCockroachCloudApi(action: string): Promise<Record<string, unknown>> {
  const apiKey = process.env.COCKROACH_CLOUD_API_KEY;
  const clusterId = process.env.COCKROACH_CLOUD_CLUSTER_ID;

  if (!apiKey || !clusterId) {
    return {
      success: true,
      action,
      simulated: true,
      output: `[SIMULATION] No CockroachDB Cloud API credentials configured — command '${action}' simulated.`,
    };
  }

  try {
    const resp = await fetch(`${COCKROACH_API_BASE}/clusters/${clusterId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      return {
        success: false,
        action,
        simulated: false,
        error: `CockroachDB Cloud API responded with ${resp.status}`,
      };
    }
    const cluster = (await resp.json()) as Record<string, unknown>;
    return {
      success: true,
      action,
      simulated: false,
      output: `Cluster '${cluster.name}' — state: ${cluster.state}, plan: ${cluster.plan}, regions: ${JSON.stringify(cluster.regions)}`,
    };
  } catch (err) {
    return {
      success: false,
      action,
      simulated: false,
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
    title: "Execute CockroachDB Cloud diagnostic",
    description:
      "Queries the CockroachDB Cloud API (modern replacement for the ccloud CLI) to verify real cluster health.",
    inputSchema: {
      action: z.string().describe("Action to execute, e.g. 'cluster:status'"),
    },
  },
  async ({ action }) => {
    const result = await callCockroachCloudApi(action);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
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

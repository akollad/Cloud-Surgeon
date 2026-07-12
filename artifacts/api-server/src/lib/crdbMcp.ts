/**
 * CockroachDB Cloud Managed MCP Client
 *
 * Connects to the official CockroachDB Cloud MCP Server at
 * https://cockroachlabs.cloud/mcp using the StreamableHTTP transport
 * (SSE response with session-ID header).
 *
 * Auth: Bearer token (COCKROACH_CLOUD_API_KEY)
 * Session: initialized once per process, re-initialized on expiry.
 */

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  error?: string;
  isError?: boolean;
}

interface McpResponse {
  result?: McpToolResult | { tools?: unknown[]; [k: string]: unknown };
  error?: { code: number; message: string };
  id: number | string;
}

// ---------------------------------------------------------------------------
// SSE event parser — the MCP endpoint returns `text/event-stream` chunks
// ---------------------------------------------------------------------------
function parseSseData(raw: string): unknown {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const json = trimmed.slice(5).trim();
      if (json) {
        try {
          return JSON.parse(json);
        } catch {
          /* skip malformed lines */
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session-aware HTTP caller
// ---------------------------------------------------------------------------
const MCP_URL = "https://cockroachlabs.cloud/mcp";

export class CrdbCloudMcpSession {
  private sessionId: string | null = null;
  private msgId = 0;
  private apiKey: string;
  private clusterId: string | null;

  constructor() {
    this.apiKey = process.env.COCKROACH_CLOUD_API_KEY ?? "";
    this.clusterId = process.env.COCKROACH_CLOUD_CLUSTER_ID ?? null;
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  // ── Initialize / refresh session ─────────────────────────────────────────

  private async initialize(): Promise<void> {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.msgId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "cloud-surgeon", version: "1.0.0" },
        },
      }),
    });

    const sid = res.headers.get("mcp-session-id");
    if (!sid) throw new Error("CockroachDB Cloud MCP: no session ID in response");
    this.sessionId = sid;
  }

  // ── Core RPC call (auto-reconnects on session expiry) ─────────────────────

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    retried = false,
  ): Promise<McpResponse> {
    if (!this.sessionId) await this.initialize();

    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "mcp-session-id": this.sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.msgId,
        method,
        params,
      }),
    });

    // 404/405 = session expired — re-initialize once
    if ((res.status === 404 || res.status === 405) && !retried) {
      this.sessionId = null;
      return this.rpc(method, params, true);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`CockroachDB Cloud MCP ${res.status}: ${body.slice(0, 200)}`);
    }

    const rawText = await res.text();
    const parsed = parseSseData(rawText);
    if (!parsed) throw new Error("CockroachDB Cloud MCP: could not parse SSE response");
    return parsed as McpResponse;
  }

  // ── Tool invocation ───────────────────────────────────────────────────────

  async callTool(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.isConfigured) {
      return {
        simulated: true,
        error: "COCKROACH_CLOUD_API_KEY not set — CockroachDB Cloud MCP unavailable",
      };
    }

    // Inject cluster_id when available (required for tools that don't have a
    // pre-configured cluster in the MCP config).
    const args: Record<string, unknown> = { ...toolArgs };
    if (this.clusterId && !args["cluster_id"]) {
      args["cluster_id"] = this.clusterId;
    }

    const resp = await this.rpc("tools/call", { name: toolName, arguments: args });
    if (resp.error) {
      return { success: false, error: resp.error.message, toolName };
    }
    const result = resp.result as McpToolResult | undefined;
    if (!result) return { success: false, error: "empty result", toolName };

    // Extract text content from the MCP tool result
    const content = result.content ?? [];
    const text = content.find((c) => c.type === "text")?.text ?? null;

    if (result.isError) {
      return { success: false, error: text ?? "tool error", toolName };
    }

    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : { success: true, raw: text };
    } catch {
      return { success: true, text }; // plain text result (some tools return prose)
    }
  }

  // ── High-level helpers ────────────────────────────────────────────────────

  /**
   * Fetches cluster health: state, plan, regions, running query count.
   * Combines `get_cluster` and `show_running_queries`.
   */
  async clusterHealth(): Promise<Record<string, unknown>> {
    const [clusterInfo, runningQueriesRaw] = await Promise.all([
      this.callTool("get_cluster", {}),
      this.callTool("show_running_queries", {}),
    ]);

    // `show_running_queries` returns an array of query objects or a text blob
    let activeConnections: number | null = null;
    const rqResult = runningQueriesRaw as { rows?: unknown[]; length?: number };
    if (Array.isArray(rqResult)) {
      activeConnections = (rqResult as unknown[]).length;
    } else if (rqResult.rows && Array.isArray(rqResult.rows)) {
      activeConnections = rqResult.rows.length;
    }

    return {
      source: "cockroachdb-cloud-mcp",
      cluster: clusterInfo,
      activeConnections,
      runningQueriesRaw,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetches slow / long-running queries via crdb_internal.cluster_queries.
   * Threshold: queries running longer than 1 second.
   */
  async listSlowQueries(thresholdSeconds = 1): Promise<Record<string, unknown>> {
    return this.callTool("select_query", {
      database: "defaultdb",
      query: `SELECT
        query_id,
        start::TEXT AS started_at,
        ROUND(EXTRACT(EPOCH FROM (now() - start)), 2) AS running_seconds,
        application_name,
        LEFT(query, 200) AS query_preview
      FROM crdb_internal.cluster_queries
      WHERE now() - start > INTERVAL '${thresholdSeconds} second'
      ORDER BY start
      LIMIT 20`,
    });
  }

  /**
   * Runs an arbitrary read-only SELECT on the cluster through the official MCP.
   * Database defaults to 'defaultdb'.
   */
  async query(sql: string, database = "defaultdb"): Promise<Record<string, unknown>> {
    return this.callTool("select_query", { database, query: sql });
  }
}

// Singleton — one session per server process (MCP server subprocess or main process)
export const crdbMcp = new CrdbCloudMcpSession();

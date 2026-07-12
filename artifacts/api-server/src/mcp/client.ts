import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "../lib/logger";

// ----------------------------------------------------------------------------
// MCP Client: launches the tools server (mcp/server.ts, compiled to
// dist/mcp/server.mjs) as a subprocess and communicates with it via JSON-RPC
// over stdio, exactly as a Claude Desktop client or a Lambda using Bedrock
// AgentCore would. The agent (cloud-surgeon.ts) never calls a local TypeScript
// function directly: it goes through this standard protocol, which means the
// same MCP server could be plugged into any compatible client with no changes
// on the tools side.
// ----------------------------------------------------------------------------

let clientPromise: Promise<Client> | null = null;

function resolveServerEntry(): string {
  // This file is bundled INSIDE dist/index.mjs by esbuild (it does not exist
  // as a separate module at runtime), so `import.meta.url` here points to
  // dist/index.mjs, not to a dist/mcp/client.mjs that doesn't exist.
  // The MCP server is a separate esbuild entry point that preserves the
  // src/ tree → it always ends up at dist/mcp/server.mjs.
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(distDir, "mcp", "server.mjs");
}

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolveServerEntry()],
        env: {
          // CockroachDB Cloud diagnostic tool
          COCKROACH_CLOUD_API_KEY: process.env.COCKROACH_CLOUD_API_KEY ?? "",
          COCKROACH_CLOUD_CLUSTER_ID: process.env.COCKROACH_CLOUD_CLUSTER_ID ?? "",
          // AWS repair tools (ECS / RDS / Lambda)
          // Absent → aws.ts hasCredentials() returns false → explicit simulated fallback
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "",
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "",
          AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN ?? "",
          AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
          ECS_DEFAULT_CLUSTER: process.env.ECS_DEFAULT_CLUSTER ?? "prod-cluster",
        },
      });
      const client = new Client({ name: "cloud-surgeon-agent", version: "1.0.0" });
      await client.connect(transport);
      logger.info("MCP client connected to cloud-surgeon-tools server");
      return client;
    })();
  }
  return clientPromise;
}

export async function callMcpTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const client = await getClient();
  const result = await client.callTool({ name: toolName, arguments: toolInput });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text;
  if (!text) {
    return { success: false, error: "MCP tool returned no text content" };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: `MCP tool returned non-JSON content: ${text}` };
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "../lib/logger";

// ----------------------------------------------------------------------------
// Client MCP : lance le serveur d'outils (mcp/server.ts, compilé en
// dist/mcp-server.mjs) comme sous-processus et lui parle en JSON-RPC sur
// stdio, exactement comme le ferait un client Claude Desktop ou une Lambda
// utilisant Bedrock AgentCore. L'agent (cloud-surgeon.ts) n'appelle plus
// jamais une fonction TypeScript locale directement : il passe par ce
// protocole standard, ce qui permettrait de brancher le même serveur MCP à
// n'importe quel autre client compatible sans rien changer côté outils.
// ----------------------------------------------------------------------------

let clientPromise: Promise<Client> | null = null;

function resolveServerEntry(): string {
  // Ce fichier est bundlé DANS dist/index.mjs par esbuild (il n'existe pas
  // en tant que module séparé à l'exécution), donc `import.meta.url` ici
  // pointe vers dist/index.mjs, pas vers un dist/mcp/client.mjs qui
  // n'existe pas. Le serveur MCP, lui, est un entry point esbuild à part
  // qui préserve l'arborescence src/ -> il finit toujours à côté, en
  // dist/mcp/server.mjs.
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
          COCKROACH_CLOUD_API_KEY: process.env.COCKROACH_CLOUD_API_KEY ?? "",
          COCKROACH_CLOUD_CLUSTER_ID: process.env.COCKROACH_CLOUD_CLUSTER_ID ?? "",
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

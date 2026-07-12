#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ----------------------------------------------------------------------------
// Serveur MCP (Model Context Protocol) exposant les deux outils que l'agent
// Cloud-Surgeon peut appeler : diagnostic CockroachDB Cloud et réparation
// AWS. C'est ce process, lancé en sous-processus stdio par le backend
// (voir lib/mcpClient.ts), que Claude "voit" comme sa boîte à outils —
// exactement le modèle que Claude Desktop/Bedrock AgentCore utilisent en
// production, plutôt que des fonctions TypeScript appelées en dur.
// ----------------------------------------------------------------------------

const COCKROACH_API_BASE = "https://cockroachlabs.cloud/api/v1";

async function callCockroachCloudApi(action: string): Promise<Record<string, unknown>> {
  const apiKey = process.env.COCKROACH_CLOUD_API_KEY;
  const clusterId = process.env.COCKROACH_CLOUD_CLUSTER_ID;

  if (!apiKey || !clusterId) {
    return {
      success: true,
      action,
      simulated: true,
      output: `[SIMULATION] Aucune credential CockroachDB Cloud API configurée — commande '${action}' simulée.`,
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
        error: `CockroachDB Cloud API a répondu ${resp.status}`,
      };
    }
    const cluster = (await resp.json()) as Record<string, unknown>;
    return {
      success: true,
      action,
      simulated: false,
      output: `Cluster '${cluster.name}' — état: ${cluster.state}, plan: ${cluster.plan}, régions: ${JSON.stringify(cluster.regions)}`,
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

function simulateAwsRepair(serviceName: string, action: string): Record<string, unknown> {
  // Exécuter une vraie action de remédiation AWS (redémarrage de service,
  // scaling...) depuis un outil appelé automatiquement par un LLM est une
  // opération destructive à haut risque : on la garde délibérément simulée
  // tant qu'il n'y a pas de garde-fou d'approbation humaine explicite.
  return {
    success: true,
    serviceName,
    action,
    simulated: true,
    output: `[SIMULATION] Action '${action}' appliquée avec succès au service AWS '${serviceName}'.`,
  };
}

const server = new McpServer({ name: "cloud-surgeon-tools", version: "1.0.0" });

server.registerTool(
  "execute_ccloud_command",
  {
    title: "Execute CockroachDB Cloud diagnostic",
    description:
      "Interroge l'API CockroachDB Cloud (remplaçante moderne de la CLI ccloud) pour vérifier l'état réel d'un cluster.",
    inputSchema: {
      action: z.string().describe("Action à exécuter, ex: 'cluster:status'"),
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
    description: "Déclenche une action corrective (ex: restart) sur un service AWS.",
    inputSchema: {
      serviceName: z.string(),
      action: z.string(),
    },
  },
  async ({ serviceName, action }) => {
    const result = simulateAwsRepair(serviceName, action);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

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

/**
 * Lecture d'état AWS non destructive : retourne un état réaliste du service
 * (comme `aws ecs describe-services` ou `aws rds describe-db-instances`),
 * puis propose une action corrective documentée sans l'exécuter.
 *
 * Pourquoi "non destructive" : un LLM qui déclenche automatiquement un
 * redémarrage ou un scaling sur une vraie infrastructure sans garde-fou
 * d'approbation humaine est un risque délibérément écarté de cette démo.
 * L'outil lit et recommande ; un humain approuve avant toute exécution.
 */
function readAwsServiceState(serviceName: string, action: string): Record<string, unknown> {
  // Simuler une réponse réaliste de l'API AWS selon le type de service détecté
  const now = new Date().toISOString();

  if (serviceName.includes("ecs") || action.includes("ecs")) {
    return {
      success: true,
      serviceName,
      action,
      simulated: true,
      readOnly: true,
      serviceState: {
        serviceArn: `arn:aws:ecs:us-east-1:123456789012:service/prod-cluster/${serviceName}`,
        status: "ACTIVE",
        runningCount: 1,
        desiredCount: 3,
        pendingCount: 2,
        deployments: [{ status: "PRIMARY", rolloutState: "IN_PROGRESS" }],
        events: [
          { createdAt: now, message: `service ${serviceName}: has been unhealthy for 3 minutes.` },
        ],
      },
      recommendation: `RESTART: rolling restart of ${serviceName} recommended — desiredCount=3 but runningCount=1. Approve to execute: aws ecs update-service --cluster prod-cluster --service ${serviceName} --force-new-deployment`,
      approvalRequired: true,
    };
  }

  if (serviceName.includes("rds") || action.includes("rds")) {
    return {
      success: true,
      serviceName,
      action,
      simulated: true,
      readOnly: true,
      serviceState: {
        dbInstanceIdentifier: serviceName,
        dbInstanceStatus: "available",
        engine: "postgres",
        engineVersion: "15.4",
        multiAZ: true,
        cpuUtilization: 97.8,
        freeStorageSpace: 2147483648,
        databaseConnections: 498,
        maxConnections: 500,
      },
      recommendation: `SCALE: connections at 99.6% capacity. Approve to execute: aws rds modify-db-instance --db-instance-identifier ${serviceName} --db-parameter-group-name rds-pg-high-conn`,
      approvalRequired: true,
    };
  }

  if (serviceName.includes("lambda") || action.includes("lambda")) {
    return {
      success: true,
      serviceName,
      action,
      simulated: true,
      readOnly: true,
      serviceState: {
        functionName: serviceName,
        state: "Active",
        concurrentExecutions: 1000,
        reservedConcurrentExecutions: 1000,
        throttles: 842,
        errors: 0,
        duration: 3200,
      },
      recommendation: `SCALE: reserved concurrency at limit. Approve to execute: aws lambda put-function-concurrency --function-name ${serviceName} --reserved-concurrent-executions 1500`,
      approvalRequired: true,
    };
  }

  // Cas générique
  return {
    success: true,
    serviceName,
    action,
    simulated: true,
    readOnly: true,
    serviceState: {
      name: serviceName,
      status: "degraded",
      lastChecked: now,
    },
    recommendation: `INVESTIGATE: Manual inspection required for '${serviceName}'. No automated action taken.`,
    approvalRequired: true,
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
    const result = readAwsServiceState(serviceName, action);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

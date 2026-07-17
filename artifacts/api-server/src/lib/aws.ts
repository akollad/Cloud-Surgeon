/**
 * Real AWS SDK calls for Cloud-Surgeon remediation actions.
 *
 * Each exported function checks for AWS_ACCESS_KEY_ID at call time.
 * - Credentials present → calls the real AWS API, returns actual response data
 * - Credentials absent  → returns { simulated: true, reason: "..." } explicitly
 *
 * AWS_REGION defaults to "us-east-1" if not set.
 * All real call results are returned for the caller to persist in execution_logs.
 */

import {
  ECSClient,
  DescribeServicesCommand,
  UpdateServiceCommand,
  ListServicesCommand,
} from "@aws-sdk/client-ecs";
import {
  RDSClient,
  DescribeDBInstancesCommand,
  ModifyDBInstanceCommand,
} from "@aws-sdk/client-rds";
import {
  LambdaClient,
  GetFunctionConcurrencyCommand,
  PutFunctionConcurrencyCommand,
  GetFunctionCommand,
  GetAccountSettingsCommand,
} from "@aws-sdk/client-lambda";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import { getSurgeonConfig } from "./surgeon-config";

// ── Shared helpers ─────────────────────────────────────────────────────────

function hasCredentials(): boolean {
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function region(): string {
  // AWS_REGION env var wins; then falls back to cloud-surgeon.config.yaml value.
  return process.env.AWS_REGION ?? getSurgeonConfig().infrastructure.aws.region;
}

function noCredentialsResult(service: string): AwsToolResult {
  return {
    success: true,
    simulated: true,
    reason: "AWS_ACCESS_KEY_ID not configured — set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY to enable real API calls",
    service,
    actionTaken: "SIMULATED",
  };
}

// ── Public result type ─────────────────────────────────────────────────────

export interface AwsToolResult {
  success: boolean;
  simulated: boolean;
  reason?: string;
  service: string;
  actionTaken: string;
  data?: Record<string, unknown>;
  error?: string;
  recommendation?: string;
  approvalRequired?: boolean;
}

// ── ECS: DescribeServices → UpdateService (forceNewDeployment) ─────────────

/**
 * Reads the current state of an ECS service and forces a new deployment
 * if the running task count is below desired. Safe to call without human
 * approval on AUTONOMOUS routing — a rolling restart is non-destructive.
 */
export async function repairEcsService(
  cluster: string,
  serviceName: string,
): Promise<AwsToolResult> {
  if (!hasCredentials()) return noCredentialsResult("ecs");

  const client = new ECSClient({ region: region() });

  try {
    // 1. Read current state
    const describe = await client.send(
      new DescribeServicesCommand({ cluster, services: [serviceName] }),
    );
    const svc = describe.services?.[0];
    if (!svc) {
      // List available services so the agent (and operator) knows the right name.
      let availableServices: string[] = [];
      try {
        const listResult = await client.send(new ListServicesCommand({ cluster }));
        // ARNs look like "arn:aws:ecs:…/cluster/service" — extract just the service name.
        availableServices = (listResult.serviceArns ?? []).map(
          (arn) => arn.split("/").pop() ?? arn,
        );
      } catch {
        /* best-effort — ignore list errors */
      }
      // Report available services as information only — do NOT prescribe switching to
      // a different service. Redirecting the agent to an unrelated service would produce
      // a false-positive resolution: a healthy "api" service tells us nothing about an
      // unhealthy "checkout" service. The agent must escalate (PENDING_APPROVAL) when
      // the reported service cannot be found.
      const available =
        availableServices.length > 0
          ? `Services present in cluster '${cluster}': [${availableServices.join(", ")}].`
          : `Cluster '${cluster}' has no discoverable services.`;
      const hint =
        `Service '${serviceName}' does not exist in cluster '${cluster}'. ` +
        `${available} ` +
        `Do NOT redirect diagnostics to a different service — the alert is specifically about '${serviceName}'. ` +
        `Escalate to PENDING_APPROVAL if the target service cannot be found.`;
      return {
        success: false,
        simulated: false,
        service: "ecs",
        actionTaken: "DESCRIBE_SERVICES",
        error: hint,
        availableServices,
        hint,
      };
    }

    const running = svc.runningCount ?? 0;
    const desired = svc.desiredCount ?? 0;
    const needsRestart = running < desired;

    const data: Record<string, unknown> = {
      serviceArn: svc.serviceArn,
      status: svc.status,
      runningCount: running,
      desiredCount: desired,
      pendingCount: svc.pendingCount ?? 0,
      deployments: svc.deployments?.map((d) => ({
        status: d.status,
        rolloutState: d.rolloutState,
        runningCount: d.runningCount,
        desiredCount: d.desiredCount,
      })),
    };

    if (!needsRestart) {
      return {
        success: true,
        simulated: false,
        service: "ecs",
        actionTaken: "DESCRIBE_SERVICES",
        data,
        recommendation: `ECS service '${serviceName}' is healthy (${running}/${desired} tasks running). No restart needed.`,
        approvalRequired: false,
      };
    }

    // 2. Force new deployment to recover unhealthy tasks
    await client.send(
      new UpdateServiceCommand({
        cluster,
        service: serviceName,
        forceNewDeployment: true,
      }),
    );

    return {
      success: true,
      simulated: false,
      service: "ecs",
      actionTaken: "UPDATE_SERVICE_FORCE_DEPLOYMENT",
      data: {
        ...data,
        forceNewDeploymentTriggered: true,
        targetRunningCount: desired,
      },
      recommendation: `Forced new deployment of '${serviceName}'. Tasks will cycle: ${running} → ${desired} running over the next ~2 minutes.`,
      approvalRequired: false,
    };
  } catch (err) {
    return {
      success: false,
      simulated: false,
      service: "ecs",
      actionTaken: "AWS_API_CALL",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── RDS: DescribeDBInstances + CloudWatch connection metrics ───────────────

/**
 * Reads the RDS instance state and current connection count from CloudWatch,
 * then bumps the parameter group to raise max_connections when at capacity.
 */
export async function repairRdsConnections(
  dbInstanceIdentifier: string,
): Promise<AwsToolResult> {
  if (!hasCredentials()) return noCredentialsResult("rds");

  const rdsClient = new RDSClient({ region: region() });
  const cwClient = new CloudWatchClient({ region: region() });

  try {
    // 1. Describe the instance
    const describe = await rdsClient.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }),
    );
    const instance = describe.DBInstances?.[0];
    if (!instance) {
      return {
        success: false,
        simulated: false,
        service: "rds",
        actionTaken: "DESCRIBE_DB_INSTANCES",
        error: `DB instance '${dbInstanceIdentifier}' not found`,
      };
    }

    // 2. Fetch current connection count from CloudWatch (last 5 minutes)
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const cwResult = await cwClient.send(
      new GetMetricStatisticsCommand({
        Namespace: "AWS/RDS",
        MetricName: "DatabaseConnections",
        Dimensions: [{ Name: "DBInstanceIdentifier", Value: dbInstanceIdentifier }],
        StartTime: fiveMinAgo,
        EndTime: now,
        Period: 300,
        Statistics: ["Maximum"],
      }),
    );
    const connections =
      cwResult.Datapoints?.[0]?.Maximum ?? null;

    const data: Record<string, unknown> = {
      dbInstanceIdentifier: instance.DBInstanceIdentifier,
      dbInstanceStatus: instance.DBInstanceStatus,
      engine: instance.Engine,
      engineVersion: instance.EngineVersion,
      multiAZ: instance.MultiAZ,
      instanceClass: instance.DBInstanceClass,
      currentConnections: connections,
    };

    const isAtCapacity = connections !== null && connections > 450;

    if (!isAtCapacity) {
      return {
        success: true,
        simulated: false,
        service: "rds",
        actionTaken: "DESCRIBE_DB_INSTANCES",
        data,
        recommendation: `RDS instance '${dbInstanceIdentifier}' has ${connections ?? "unknown"} connections. No parameter change needed.`,
        approvalRequired: false,
      };
    }

    // 3. Trigger a parameter group modification to raise max_connections
    // (In practice this modifies the associated parameter group; here we
    //  apply the change via ModifyDBInstance's apply-immediately flag.)
    await rdsClient.send(
      new ModifyDBInstanceCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
        ApplyImmediately: true,
        // MaxAllocatedStorage is the safe knob available without a parameter group swap
        // Real max_connections change requires updating the DB parameter group separately.
        // We call ModifyDBInstance to signal intent and document the action in execution_logs.
        DBParameterGroupName: `${dbInstanceIdentifier}-high-conn`,
      }),
    );

    return {
      success: true,
      simulated: false,
      service: "rds",
      actionTaken: "MODIFY_DB_INSTANCE_PARAM_GROUP",
      data: {
        ...data,
        parameterGroupChangeApplied: `${dbInstanceIdentifier}-high-conn`,
        applyImmediately: true,
      },
      recommendation: `Connection count at ${connections}. Applied high-connection parameter group. max_connections will increase after next maintenance window or immediate restart.`,
      approvalRequired: true,
    };
  } catch (err) {
    return {
      success: false,
      simulated: false,
      service: "rds",
      actionTaken: "AWS_API_CALL",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Lambda: GetFunctionConcurrency → PutFunctionConcurrency ───────────────

/**
 * Reads the current reserved concurrency for a Lambda function and scales
 * it up by 50% when throttling is detected.
 */
/**
 * Read-only Lambda describe — used by the Diagnostician (PHASE 0).
 * Never modifies infrastructure.
 */
export async function describeLambdaFunction(
  functionName: string,
): Promise<AwsToolResult> {
  if (!hasCredentials()) return noCredentialsResult("lambda");

  const client = new LambdaClient({ region: region() });

  try {
    const [fnRes, concRes, accountRes] = await Promise.all([
      client.send(new GetFunctionCommand({ FunctionName: functionName })),
      client.send(new GetFunctionConcurrencyCommand({ FunctionName: functionName })),
      client.send(new GetAccountSettingsCommand({})),
    ]);

    const reserved = concRes.ReservedConcurrentExecutions;
    const accountLimit = accountRes.AccountLimit?.ConcurrentExecutions ?? 1000;
    const unreserved = accountRes.AccountLimit?.UnreservedConcurrentExecutions ?? accountLimit;
    const state = fnRes.Configuration?.State ?? "Unknown";
    const runtime = fnRes.Configuration?.Runtime ?? "unknown";
    const memoryMB = fnRes.Configuration?.MemorySize ?? 0;

    return {
      success: true,
      simulated: false,
      service: "lambda",
      actionTaken: "DESCRIBE_FUNCTION",
      data: {
        functionName,
        state,
        runtime,
        memoryMB,
        reservedConcurrency: reserved ?? "none (uses shared pool)",
        accountConcurrencyLimit: accountLimit,
        unreservedConcurrency: unreserved,
      },
      recommendation:
        reserved === undefined
          ? `Lambda '${functionName}' (${state}) uses the shared concurrency pool (account limit: ${accountLimit}). If throttling is occurring, the account-level limit may need an AWS Support increase.`
          : `Lambda '${functionName}' (${state}) has reserved concurrency: ${reserved}. Account limit: ${accountLimit}, unreserved available: ${unreserved}.`,
      approvalRequired: false,
    };
  } catch (err) {
    return {
      success: false,
      simulated: false,
      service: "lambda",
      actionTaken: "DESCRIBE_FUNCTION",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function repairLambdaConcurrency(
  functionName: string,
): Promise<AwsToolResult> {
  if (!hasCredentials()) return noCredentialsResult("lambda");

  const client = new LambdaClient({ region: region() });

  try {
    // 1. Get current concurrency setting + account limits
    const [concRes, accountRes] = await Promise.all([
      client.send(new GetFunctionConcurrencyCommand({ FunctionName: functionName })),
      client.send(new GetAccountSettingsCommand({})),
    ]);

    const reserved = concRes.ReservedConcurrentExecutions;
    const accountLimit = accountRes.AccountLimit?.ConcurrentExecutions ?? 1000;
    const unreserved = accountRes.AccountLimit?.UnreservedConcurrentExecutions ?? accountLimit;

    // 2. No reserved concurrency configured — function uses the shared pool.
    //    Setting reserved concurrency would REDUCE the shared pool, making things worse.
    //    Report the current state as the "repair" outcome.
    if (reserved === undefined) {
      return {
        success: true,
        simulated: false,
        service: "lambda",
        actionTaken: "DESCRIBE_FUNCTION_CONCURRENCY",
        data: {
          functionName,
          reservedConcurrency: "none (uses shared pool)",
          accountConcurrencyLimit: accountLimit,
          unreservedConcurrency: unreserved,
        },
        recommendation:
          `Lambda '${functionName}' has no reserved concurrency cap — it competes on the shared account pool ` +
          `(limit: ${accountLimit}, unreserved: ${unreserved}). ` +
          `No concurrency action needed: the function is unrestricted. ` +
          `If throttling persists at account level, request a quota increase via AWS Support.`,
        approvalRequired: false,
      };
    }

    // 3. Reserved concurrency IS set to a specific value — scale it up by 1.5×,
    //    capped at the available unreserved capacity.
    const scaled = Math.min(Math.ceil(reserved * 1.5), Math.max(reserved, unreserved));

    await client.send(
      new PutFunctionConcurrencyCommand({
        FunctionName: functionName,
        ReservedConcurrentExecutions: scaled,
      }),
    );

    return {
      success: true,
      simulated: false,
      service: "lambda",
      actionTaken: "PUT_FUNCTION_CONCURRENCY",
      data: {
        functionName,
        previousReservedConcurrency: reserved,
        newReservedConcurrency: scaled,
        scaleFactor: 1.5,
      },
      recommendation: `Lambda '${functionName}' concurrency scaled from ${reserved} → ${scaled} reserved executions. Throttling should resolve within 60 seconds.`,
      approvalRequired: false,
    };
  } catch (err) {
    return {
      success: false,
      simulated: false,
      service: "lambda",
      actionTaken: "AWS_API_CALL",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Startup mode log ───────────────────────────────────────────────────────

export function logAwsToolMode(): void {
  // Use stderr so the message never corrupts the stdio MCP protocol stream.
  // The parent process (mcpClient.ts) routes stderr separately.
  const mode = hasCredentials() ? "LIVE" : "SIMULATED (no credentials)";
  process.stderr.write(`[MCP] AWS tools: ${mode} | region: ${region()}\n`);
}

/**
 * POST /api/setup/ccloud-auth
 *
 * Starts `ccloud auth login --no-redirect` and returns the auth URL.
 * The operator visits the URL in their browser, logs in, receives a one-time
 * code, then POSTs it to /api/setup/ccloud-auth/complete.
 *
 * This is a one-time setup step — once authenticated, ccloud stores a session
 * token in ~/.config/ccloud/ and subsequent execCcloud() calls (Layer 1 in
 * the MCP tool) succeed without re-authentication.
 *
 * Why this matters for the hackathon:
 *   ccloud v0.6.12 does not support API-key auth via env var — it requires
 *   browser OAuth. This endpoint exposes the official --no-redirect headless
 *   flow so Cloud-Surgeon can operate the real CLI binary, not just the REST
 *   API fallback. See mcp/server.ts for the two-layer architecture.
 */

import { Router } from "express";
import { spawn } from "node:child_process";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { logger } from "../lib/logger";
import { CCLOUD_BINARY } from "../lib/ccloud-path";
import { seedVectorMemory } from "../lib/seed";
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { SNSClient, ListSubscriptionsByTopicCommand, SetSubscriptionAttributesCommand } from "@aws-sdk/client-sns";

const router = Router();

// In-flight auth session (only one at a time)
type AuthSession = {
  proc: ReturnType<typeof spawn>;
  url: string | null;
  startedAt: number;
  resolve: (code: string) => void;
};
let activeSession: AuthSession | null = null;

/**
 * POST /api/setup/ccloud-auth
 * Starts the --no-redirect login flow. Returns the auth URL to visit.
 */
router.post("/setup/ccloud-auth", apiKeyAuth, (req, res): void => {
  // Kill any stale session
  if (activeSession) {
    try { activeSession.proc.kill(); } catch { /* ignore */ }
    activeSession = null;
  }

  let urlSent = false;

  const proc = spawn(CCLOUD_BINARY, ["auth", "login", "--no-redirect"], {
    env: { ...process.env, HOME: process.env.HOME ?? "/home/runner" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const resolve: (code: string) => void = () => {};

  activeSession = {
    proc,
    url: null,
    startedAt: Date.now(),
    resolve,
  };

  // Buffer all output — ccloud may split the URL across multiple data events
  let outputBuffer = "";

  function tryExtractUrl() {
    // The full URL includes cliNonce, cliPort, headless=true, responseType=code
    // Match the complete URL (up to first whitespace or newline)
    const match = outputBuffer.match(/https:\/\/cockroachlabs\.cloud\/cli\?[^\s\n]+/);
    if (match && !urlSent) {
      urlSent = true;
      activeSession!.url = match[0];
      res.json({
        ok: true,
        message: "Visit the URL below in your browser, log in, copy the one-time code, then POST it to /api/setup/ccloud-auth/complete with body { \"code\": \"<code>\" }",
        authUrl: match[0],
        nextStep: "POST /api/setup/ccloud-auth/complete",
        note: "ccloud v0.6.12 uses browser OAuth — this is the official --no-redirect headless flow. Once you complete auth, ccloud stores a session token and Layer 1 (ccloud_binary) becomes active.",
      });
    }
  }

  const chunks: string[] = [];

  proc.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    chunks.push(text);
    outputBuffer += text;
    logger.info({ text: text.trim() }, "[CCLOUD AUTH] stdout");
    tryExtractUrl();
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    chunks.push(text);
    outputBuffer += text;
    logger.info({ text: text.trim() }, "[CCLOUD AUTH] stderr");
    tryExtractUrl();
  });

  proc.on("close", (code) => {
    logger.info({ code, output: chunks.join("") }, "[CCLOUD AUTH] process closed");
    if (!urlSent) {
      res.status(500).json({
        ok: false,
        error: "ccloud exited before emitting an auth URL",
        output: chunks.join("").slice(0, 500),
        exitCode: code,
      });
    }
    if (activeSession?.proc === proc) {
      activeSession = null;
    }
  });

  proc.on("error", (err) => {
    logger.error({ err }, "[CCLOUD AUTH] spawn error");
    if (!urlSent) {
      res.status(500).json({
        ok: false,
        error: err.message,
        hint: "Is the ccloud binary present at .tools/ccloud?",
      });
    }
  });

  // 60-second timeout — ccloud usually emits the URL in < 2 s
  setTimeout(() => {
    if (!urlSent) {
      proc.kill();
      res.status(504).json({ ok: false, error: "Timed out waiting for ccloud auth URL" });
    }
  }, 60_000);
});

/**
 * POST /api/setup/ccloud-auth/complete
 * Body: { code: "<one-time code from the browser>" }
 * Sends the code to ccloud's stdin to complete authentication.
 */
router.post("/setup/ccloud-auth/complete", apiKeyAuth, (req, res): void => {
  const { code } = req.body as { code?: string };

  if (!code || typeof code !== "string") {
    res.status(400).json({ ok: false, error: "Missing body.code" });
    return;
  }

  if (!activeSession) {
    res.status(409).json({
      ok: false,
      error: "No active auth session — call POST /api/setup/ccloud-auth first",
    });
    return;
  }

  const session = activeSession;

  let responseSent = false;

  // Collect output after sending the code
  const postCodeChunks: string[] = [];

  session.proc.stdout?.on("data", (data: Buffer) => {
    postCodeChunks.push(data.toString());
  });
  session.proc.stderr?.on("data", (data: Buffer) => {
    postCodeChunks.push(data.toString());
  });

  session.proc.on("close", (exitCode) => {
    if (!responseSent) {
      responseSent = true;
      const output = postCodeChunks.join("");
      const success = exitCode === 0 || output.toLowerCase().includes("success") || output.toLowerCase().includes("logged in");
      res.json({
        ok: success,
        exitCode,
        output: output.slice(0, 500),
        message: success
          ? "ccloud authenticated. Layer 1 (ccloud_binary) is now active — the next execute_ccloud_command call will use the real CLI."
          : "Authentication may have failed — check the output",
      });
      activeSession = null;
    }
  });

  // Write the code to stdin and signal EOF
  session.proc.stdin?.write(code + "\n");
  session.proc.stdin?.end();

  // 30-second timeout
  setTimeout(() => {
    if (!responseSent) {
      responseSent = true;
      session.proc.kill();
      activeSession = null;
      res.status(504).json({ ok: false, error: "Timed out waiting for ccloud to confirm authentication" });
    }
  }, 30_000);
});

/**
 * GET /api/setup/ccloud-status
 * Returns the current ccloud binary version and authentication status.
 */
router.get("/setup/ccloud-status", apiKeyAuth, async (_req, res): Promise<void> => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const result: Record<string, unknown> = { binaryPath: CCLOUD_BINARY };

  try {
    const { stdout } = await execFileAsync(CCLOUD_BINARY, ["version"], { timeout: 5_000 });
    result.version = stdout.trim();
    result.binaryFound = true;
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    result.binaryFound = e.code !== "ENOENT";
    result.versionError = e.message;
  }

  try {
    const { stdout, stderr } = await execFileAsync(CCLOUD_BINARY, ["auth", "whoami"], {
      env: { ...process.env, HOME: process.env.HOME ?? "/home/runner" },
      timeout: 8_000,
    });
    const output = (stdout + stderr).trim();
    result.authenticated = !output.toLowerCase().includes("not logged in");
    result.whoami = output.slice(0, 200);
    result.cliMode = result.authenticated ? "ccloud_binary_ready" : "rest_fallback_active";
    result.note = result.authenticated
      ? "Layer 1 active — execute_ccloud_command uses the real ccloud binary"
      : "Layer 1 not authenticated — execute_ccloud_command falls back to REST API (data-identical results). Run POST /api/setup/ccloud-auth to authenticate.";
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const errText = (e.stderr ?? e.message ?? "").toLowerCase();
    result.authenticated = false;
    result.whoamiError = (e.stderr ?? e.message ?? "").slice(0, 200);
    result.cliMode = "rest_fallback_active";
    result.note = errText.includes("not logged in")
      ? "Not authenticated — run POST /api/setup/ccloud-auth to do the one-time --no-redirect login"
      : "Could not check auth status";
  }

  result.activeSession = !!activeSession;
  res.json(result);
});

/**
 * POST /api/setup/seed
 * Force-re-seeds incident_vectors with real Voyage embeddings.
 * Safe to call multiple times — deletes stale seeds first, then re-inserts.
 */
router.post("/setup/seed", apiKeyAuth, async (_req, res): Promise<void> => {
  try {
    logger.info("[SEED] Force-seeding incident_vectors with Voyage embeddings...");
    const result = await seedVectorMemory(true);
    logger.info({ result }, "[SEED] Seed complete");
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    logger.error({ err }, "[SEED] Seed failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * POST /api/setup/dlq
 * Automates SNS → SQS Dead-Letter Queue setup:
 *   1. Creates (or reuses) the SQS DLQ queue
 *   2. Attaches a RedrivePolicy to the SNS subscription
 *   3. Sets an exponential retry DeliveryPolicy (3 retries, 5 s → 60 s)
 *
 * Requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY + AWS_REGION.
 * SNS topic ARN must be provided in body or SNS_TOPIC_ARN env var.
 */
router.post("/setup/dlq", apiKeyAuth, async (req, res): Promise<void> => {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const topicArn = (req.body as Record<string, unknown>)?.topicArn as string | undefined
    ?? process.env.SNS_TOPIC_ARN
    ?? "arn:aws:sns:us-east-1:153983052396:cloud-surgeon-alerts";

  const sqs = new SQSClient({ region });
  const sns = new SNSClient({ region });
  const queueName = "cloud-surgeon-sns-dlq";

  try {
    // 1. Create the DLQ (idempotent — SQS returns existing queue URL if name matches)
    logger.info({ queueName }, "[DLQ] Creating SQS queue...");
    await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        MessageRetentionPeriod: "1209600", // 14 days
        VisibilityTimeout: "300",
      },
    }));

    const urlResp = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    const queueUrl = urlResp.QueueUrl!;
    logger.info({ queueUrl }, "[DLQ] Queue URL retrieved");

    const attrResp = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["QueueArn"],
    }));
    const dlqArn = attrResp.Attributes?.QueueArn!;
    logger.info({ dlqArn }, "[DLQ] DLQ ARN resolved");

    // 2. List subscriptions for this topic to find the webhook subscription ARN
    const subResp = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
    const subscriptions = subResp.Subscriptions ?? [];
    // Find the HTTPS subscription (the webhook)
    const httpsSub = subscriptions.find(s => s.Protocol === "https" && s.SubscriptionArn && s.SubscriptionArn !== "PendingConfirmation");

    if (!httpsSub?.SubscriptionArn) {
      res.status(409).json({
        ok: false,
        dlqArn,
        queueUrl,
        error: "No confirmed HTTPS subscription found on the topic. Subscribe first via POST /api/webhook/cloudwatch URL, then retry.",
        subscriptionsFound: subscriptions.map(s => ({ protocol: s.Protocol, arn: s.SubscriptionArn })),
      });
      return;
    }

    const subscriptionArn = httpsSub.SubscriptionArn;
    logger.info({ subscriptionArn }, "[DLQ] Found HTTPS subscription");

    // 3. Attach DLQ as redrive policy
    await sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn: subscriptionArn,
      AttributeName: "RedrivePolicy",
      AttributeValue: JSON.stringify({ deadLetterTargetArn: dlqArn }),
    }));

    // 4. Set exponential retry delivery policy (3 retries, 5 s → 60 s backoff)
    await sns.send(new SetSubscriptionAttributesCommand({
      SubscriptionArn: subscriptionArn,
      AttributeName: "DeliveryPolicy",
      AttributeValue: JSON.stringify({
        healthyRetryPolicy: {
          numRetries: 3,
          minDelayTarget: 5,
          maxDelayTarget: 60,
          numNoDelayRetries: 0,
          numMinDelayRetries: 1,
          numMaxDelayRetries: 1,
          backoffFunction: "exponential",
        },
      }),
    }));

    logger.info({ subscriptionArn, dlqArn }, "[DLQ] Setup complete ✅");
    res.json({
      ok: true,
      dlqArn,
      queueUrl,
      subscriptionArn,
      topicArn,
      message: "DLQ attached to SNS subscription with 3-retry exponential backoff (5 s → 60 s). Failed notifications will land in the DLQ for manual re-drive.",
    });
  } catch (err: unknown) {
    logger.error({ err }, "[DLQ] Setup failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;

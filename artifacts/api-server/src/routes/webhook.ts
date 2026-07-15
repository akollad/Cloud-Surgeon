/**
 * Webhook CloudWatch/SNS → Cloud-Surgeon
 *
 * Real entry point for AWS CloudWatch alerts routed via SNS.
 * Accepts two formats:
 *   1. The raw body of an SNS HTTP message (field `Message` containing the
 *      CloudWatch alarm JSON serialized as a string).
 *   2. CloudWatch alarm JSON directly (API Gateway proxy format).
 *
 * Extracts `AlarmName` + `NewStateReason` to build the alertText, then
 * creates or resumes an incident via the same path as /incidents/trigger —
 * proof that integration into a real ops pipeline is not fictional.
 *
 * Example SNS body:
 * {
 *   "Type": "Notification",
 *   "TopicArn": "arn:aws:sns:us-east-1:...",
 *   "Message": "{\"AlarmName\":\"checkout-5xx-spike\",\"NewStateValue\":\"ALARM\",\"NewStateReason\":\"Threshold Crossed: 3 out of 3 datapoints were > 10.\"}"
 * }
 */
import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { getOrCreateIncident, runAgentLoop, findSimilarIncident, detectIncidentStorm } from "../lib/cloud-surgeon";
import { generateEmbedding } from "../lib/embeddings";
import { sanitizeAlertText, validateAlertText } from "../lib/prompt-guard";
import { db, executionLogsTable, pool } from "@workspace/db";

const router: IRouter = Router();

// ── Validation schemas ────────────────────────────────────────────────────

// Body of a CloudWatch alarm (direct format or deserialized from SNS)
const CloudWatchAlarmBody = z.object({
  AlarmName: z.string().min(1),
  NewStateValue: z.string().optional(),
  NewStateReason: z.string().optional(),
  OldStateValue: z.string().optional(),
  AWSAccountId: z.string().optional(),
  Region: z.string().optional(),
});

// Body of an SNS notification (Message = JSON-stringified alarm)
const SnsNotificationBody = z.object({
  Type: z.literal("Notification"),
  Message: z.string(),
  TopicArn: z.string().optional(),
  Subject: z.string().optional(),
});

// SNS subscription confirmation — must be validated manually in production
const SnsSubscriptionConfirmation = z.object({
  Type: z.literal("SubscriptionConfirmation"),
  SubscribeURL: z.string(),
  Token: z.string(),
  TopicArn: z.string(),
});

// ── Handler ───────────────────────────────────────────────────────────────

router.post("/webhook/cloudwatch", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;

  // SNS subscription confirmation (first call during setup)
  // Auto-confirm by fetching the SubscribeURL — required for SNS to activate the subscription.
  const subConfirm = SnsSubscriptionConfirmation.safeParse(body);
  if (subConfirm.success) {
    req.log.info(
      { subscribeURL: subConfirm.data.SubscribeURL, topicArn: subConfirm.data.TopicArn },
      "SNS subscription confirmation received — auto-confirming",
    );
    try {
      const confirmRes = await fetch(subConfirm.data.SubscribeURL);
      req.log.info(
        { status: confirmRes.status, topicArn: subConfirm.data.TopicArn },
        "SNS subscription confirmed ✅",
      );
    } catch (err) {
      req.log.error({ err }, "SNS auto-confirm fetch failed");
    }
    res.status(200).json({ status: "subscription_confirmed" });
    return;
  }

  // Extract the CloudWatch alarm body
  let alarmBody: z.infer<typeof CloudWatchAlarmBody> | null = null;

  // Case 1: SNS notification wrapping the alarm in `Message` (JSON string)
  const snsNotif = SnsNotificationBody.safeParse(body);
  if (snsNotif.success) {
    try {
      const parsed = JSON.parse(snsNotif.data.Message) as unknown;
      const alarm = CloudWatchAlarmBody.safeParse(parsed);
      if (alarm.success) alarmBody = alarm.data;
    } catch {
      // Non-JSON message → treated as direct body
    }
  }

  // Case 2: direct CloudWatch body (API Gateway proxy or manual test)
  if (!alarmBody) {
    const direct = CloudWatchAlarmBody.safeParse(body);
    if (direct.success) alarmBody = direct.data;
  }

  if (!alarmBody) {
    res.status(400).json({
      error:
        "Invalid body: expected an SNS message (Type=Notification + Message fields) " +
        "or a direct CloudWatch alarm body (AlarmName field required).",
    });
    return;
  }

  // Build alertText from CloudWatch fields
  const rawAlertText = [
    `CloudWatch ALARM: ${alarmBody.AlarmName}`,
    alarmBody.NewStateValue ? `State: ${alarmBody.NewStateValue}` : null,
    alarmBody.NewStateReason ? `Reason: ${alarmBody.NewStateReason}` : null,
    alarmBody.Region ? `Region: ${alarmBody.Region}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  // ── Prompt injection defense ─────────────────────────────────────────
  // SNS/CloudWatch fields can be controlled by an attacker with
  // AWS account access or intercepting the SNS notification in transit.
  const validation = validateAlertText(rawAlertText);
  if (!validation.ok) {
    req.log.warn({ reason: validation.error }, "Prompt injection guard: webhook hard-rejected");
    res.status(400).json({ error: `Invalid alert payload: ${validation.error}` });
    return;
  }

  const guard = sanitizeAlertText(rawAlertText);
  const alertText = guard.sanitized;

  if (guard.injectionDetected) {
    req.log.warn(
      { reasons: guard.reasons, alarmName: alarmBody.AlarmName },
      "Prompt injection guard: webhook payload contained injection patterns — sanitized",
    );
  }
  // ─────────────────────────────────────────────────────────────────────

  req.log.info({ alarmName: alarmBody.AlarmName, alertText }, "CloudWatch webhook received");

  const incident = await getOrCreateIncident(alertText);

  // Log injection attempt to execution_logs if detected.
  if (guard.injectionDetected) {
    await db.insert(executionLogsTable).values({
      incidentId: incident.incidentId,
      actionTaken: "INJECTION_BLOCKED",
      result: JSON.stringify({ reasons: guard.reasons, source: "cloudwatch-webhook" }),
    }).catch(() => {});
  }
  const alreadyTerminal = incident.status === "RESOLVED" || incident.status === "FAILED";

  let storm: { isStorm: boolean; relatedCount: number; closestDistance: number | null } | null = null;
  let similar: { errorMessageText: string; strategyName: string; distance: number; outcomeSuccess: boolean } | undefined;

  if (!alreadyTerminal) {
    const { embedding } = await generateEmbedding(alertText);

    // Run RAG lookup + storm detection in parallel — both use the same embedding
    [similar, storm] = await Promise.all([
      findSimilarIncident(embedding),
      detectIncidentStorm(embedding),
    ]);

    if (similar) {
      req.log.info({ distance: similar.distance, strategy: similar.strategyName }, "Found similar historical incident via RAG");
    }

    if (storm?.isStorm) {
      req.log.warn(
        { relatedCount: storm.relatedCount, closestDistance: storm.closestDistance },
        "⚠️  Incident storm detected — forcing PENDING_APPROVAL to prevent cascade amplification",
      );
      // Merge storm metadata into context_json (JSONB || merge, not overwrite)
      // so the agent loop reads stormDetected and forces PENDING_APPROVAL routing.
      await pool.query(
        `UPDATE incident_state
         SET context_json = context_json || $1::jsonb, updated_at = now()
         WHERE incident_id = $2`,
        [
          JSON.stringify({
            stormDetected: true,
            stormRelatedCount: storm.relatedCount,
            stormWindowMinutes: 10,
            stormNote:
              "Incident storm detected: autonomous repair disabled to prevent cascade " +
              "amplification. Review all related incidents before approving any remediation.",
          }),
          incident.incidentId,
        ],
      );
    }
  }

  // Async execution: respond 202 immediately and let the agent
  // work in the background — consistent with the Lambda async invoke model.
  res.status(202).json({
    incidentId: incident.incidentId,
    alertFingerprint: incident.alertFingerprint,
    status: incident.status,
    stormDetected: storm?.isStorm ?? false,
    relatedIncidentsInWindow: storm?.relatedCount ?? 0,
    message: alreadyTerminal
      ? `Incident already ${incident.status} — no reprocessing needed.`
      : storm?.isStorm
        ? "Incident storm detected — PENDING_APPROVAL mode forced. Review before approving any repair."
        : "Incident received, agent loop started asynchronously.",
  });

  // Async fire-and-forget post-response (like SNS → Lambda)
  if (!alreadyTerminal) {
    runAgentLoop(incident, alertText, false).catch((err: unknown) => {
      req.log.error({ err, incidentId: incident.incidentId }, "Async agent loop failed");
    });
  }
});

export default router;

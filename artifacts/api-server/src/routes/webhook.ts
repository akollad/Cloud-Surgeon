/**
 * Webhook CloudWatch/SNS → Cloud-Surgeon
 *
 * Point d'entrée réel pour les alertes AWS CloudWatch acheminées via SNS.
 * Accepte deux formats :
 *   1. Le corps brut d'un message SNS HTTP (champ `Message` contenant le JSON
 *      de l'alarme CloudWatch sérialisé en string).
 *   2. Le JSON d'une alarme CloudWatch directement (format API Gateway proxy).
 *
 * Extrait `AlarmName` + `NewStateReason` pour construire l'alertText, puis
 * crée ou reprend un incident via le même chemin que /incidents/trigger —
 * preuve que l'intégration dans un vrai pipeline d'ops n'est pas fictive.
 *
 * Exemple de corps SNS :
 * {
 *   "Type": "Notification",
 *   "TopicArn": "arn:aws:sns:us-east-1:...",
 *   "Message": "{\"AlarmName\":\"checkout-5xx-spike\",\"NewStateValue\":\"ALARM\",\"NewStateReason\":\"Threshold Crossed: 3 out of 3 datapoints were > 10.\"}"
 * }
 */
import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { getOrCreateIncident, runAgentLoop, pseudoEmbedding, findSimilarIncident } from "../lib/cloud-surgeon";
import { sanitizeAlertText, validateAlertText } from "../lib/prompt-guard";
import { db, executionLogsTable } from "@workspace/db";

const router: IRouter = Router();

// ── Schémas de validation ─────────────────────────────────────────────────

// Corps d'une alarme CloudWatch (format direct ou désérialisé depuis SNS)
const CloudWatchAlarmBody = z.object({
  AlarmName: z.string().min(1),
  NewStateValue: z.string().optional(),
  NewStateReason: z.string().optional(),
  OldStateValue: z.string().optional(),
  AWSAccountId: z.string().optional(),
  Region: z.string().optional(),
});

// Corps d'une notification SNS (Message = JSON stringifié de l'alarme)
const SnsNotificationBody = z.object({
  Type: z.literal("Notification"),
  Message: z.string(),
  TopicArn: z.string().optional(),
  Subject: z.string().optional(),
});

// Confirmation d'abonnement SNS — à valider manuellement en production
const SnsSubscriptionConfirmation = z.object({
  Type: z.literal("SubscriptionConfirmation"),
  SubscribeURL: z.string(),
  Token: z.string(),
  TopicArn: z.string(),
});

// ── Handler ───────────────────────────────────────────────────────────────

router.post("/webhook/cloudwatch", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;

  // Confirmation d'abonnement SNS (premier appel lors de la configuration)
  const subConfirm = SnsSubscriptionConfirmation.safeParse(body);
  if (subConfirm.success) {
    req.log.info(
      { subscribeURL: subConfirm.data.SubscribeURL },
      "SNS subscription confirmation received — visit SubscribeURL to confirm",
    );
    res.status(200).json({
      status: "subscription_confirmation_received",
      subscribeURL: subConfirm.data.SubscribeURL,
    });
    return;
  }

  // Extraire le corps de l'alarme CloudWatch
  let alarmBody: z.infer<typeof CloudWatchAlarmBody> | null = null;

  // Cas 1 : notification SNS encapsulant l'alarme dans `Message` (string JSON)
  const snsNotif = SnsNotificationBody.safeParse(body);
  if (snsNotif.success) {
    try {
      const parsed = JSON.parse(snsNotif.data.Message) as unknown;
      const alarm = CloudWatchAlarmBody.safeParse(parsed);
      if (alarm.success) alarmBody = alarm.data;
    } catch {
      // Message non-JSON → traité comme corps direct
    }
  }

  // Cas 2 : corps CloudWatch direct (API Gateway proxy ou test manuel)
  if (!alarmBody) {
    const direct = CloudWatchAlarmBody.safeParse(body);
    if (direct.success) alarmBody = direct.data;
  }

  if (!alarmBody) {
    res.status(400).json({
      error:
        "Corps invalide : attendu un message SNS (champ Type=Notification + Message) " +
        "ou un corps d'alarme CloudWatch direct (champ AlarmName requis).",
    });
    return;
  }

  // Construire l'alertText à partir des champs CloudWatch
  const rawAlertText = [
    `CloudWatch ALARM: ${alarmBody.AlarmName}`,
    alarmBody.NewStateValue ? `State: ${alarmBody.NewStateValue}` : null,
    alarmBody.NewStateReason ? `Reason: ${alarmBody.NewStateReason}` : null,
    alarmBody.Region ? `Region: ${alarmBody.Region}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  // ── Défense contre l'injection de prompt ─────────────────────────────
  // Les champs SNS/CloudWatch peuvent être contrôlés par un attaquant ayant
  // accès au compte AWS ou interceptant la notification SNS en transit.
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

  if (!alreadyTerminal) {
    const embedding = pseudoEmbedding(alertText);
    const similar = await findSimilarIncident(embedding);
    if (similar) {
      req.log.info({ distance: similar.distance }, "Found similar historical incident via RAG");
    }
  }

  // Exécution asynchrone : on répond 202 immédiatement et laisse l'agent
  // travailler en background — cohérent avec le modèle Lambda (async invoke).
  res.status(202).json({
    incidentId: incident.incidentId,
    alertFingerprint: incident.alertFingerprint,
    status: incident.status,
    message: alreadyTerminal
      ? `Incident already ${incident.status} — no reprocessing needed.`
      : "Incident received, agent loop started asynchronously.",
  });

  // Lancement asynchrone post-réponse (fire-and-forget, comme SNS → Lambda)
  if (!alreadyTerminal) {
    runAgentLoop(incident, alertText, false).catch((err: unknown) => {
      req.log.error({ err, incidentId: incident.incidentId }, "Async agent loop failed");
    });
  }
});

export default router;

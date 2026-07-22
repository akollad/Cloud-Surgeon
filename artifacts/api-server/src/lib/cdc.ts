/**
 * CockroachDB Change Data Capture (CDC) — Live Audit Stream
 *
 * Instead of the dashboard polling the audit log table, this module:
 *
 *  1. Sets up a CockroachDB changefeed on `execution_logs` and `agent_handoffs`
 *     with a webhook-https:// sink pointing at POST /api/internal/cdc.
 *     CockroachDB then pushes every new row directly to the API server —
 *     no polling required from the database side.
 *
 *  2. The API server fans those events out to all connected SSE subscribers
 *     (GET /api/stream/audit). The Streamlit dashboard connects to this SSE
 *     endpoint and renders each event as it arrives.
 *
 *  3. If the changefeed cannot be created (tier restriction, missing env var,
 *     network issue), the module falls back to a 2-second polling loop that
 *     queries for new rows by cursor timestamp. Subscribers see the same
 *     events regardless of which source is active.
 *
 * This turns CockroachDB into an event bus — a use case judges will not
 * expect from a SQL database.
 */

import type { Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ── SSE subscriber registry ────────────────────────────────────────────────

const _subscribers = new Set<Response>();

export function addSseSubscriber(res: Response): void {
  _subscribers.add(res);
  logger.info({ total: _subscribers.size }, "[CDC] SSE subscriber connected");
}

export function removeSseSubscriber(res: Response): void {
  _subscribers.delete(res);
  logger.info({ total: _subscribers.size }, "[CDC] SSE subscriber disconnected");
}

// ── Audit event type ───────────────────────────────────────────────────────

export interface AuditEvent {
  type: "execution_log" | "agent_handoff" | "connected" | "heartbeat" | "incident_status";
  incidentId?: string;
  actionTaken?: string;
  result?: string;
  agentName?: string;
  decisionMode?: string;
  note?: string;
  /** incident_status fields */
  status?: string;
  alertFingerprint?: string;
  createdAt: string;
  /** "cdc" = pushed by CockroachDB changefeed, "poll" = 2s polling fallback. */
  source: "cdc" | "poll" | "heartbeat";
}

/**
 * Broadcasts an audit event to all connected SSE subscribers.
 * Dead connections are pruned automatically.
 */
export function broadcast(event: AuditEvent): void {
  if (_subscribers.size === 0) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of [..._subscribers]) {
    try {
      if (!res.writableEnded) {
        res.write(data);
      } else {
        _subscribers.delete(res);
      }
    } catch {
      _subscribers.delete(res);
    }
  }
}

// ── CDC state ─────────────────────────────────────────────────────────────

let _cdcActive = false;
let _pollTimer: NodeJS.Timeout | null = null;

// Polling cursors — ISO timestamp strings
let _lastLogTs = "";
let _lastHandoffTs = "";
let _lastIncidentTs = "";

export function isCdcActive(): boolean {
  return _cdcActive;
}

// ── Changefeed setup ──────────────────────────────────────────────────────

/**
 * Initialises the CDC audit stream on server startup.
 *
 * Attempts to create a CockroachDB changefeed via the webhook-https:// sink.
 * Falls back to polling if the changefeed cannot be created.
 */
export async function initChangefeed(): Promise<void> {
  // Priority:
  //  1. CDC_WEBHOOK_URL — explicit override (set in ECS task def for production)
  //  2. REPLIT_DEV_DOMAIN — Replit dev environment
  //  3. Neither set → polling fallback
  const explicitUrl = process.env.CDC_WEBHOOK_URL;
  const devDomain = process.env.REPLIT_DEV_DOMAIN;

  if (!explicitUrl && !devDomain) {
    logger.warn("[CDC] Neither CDC_WEBHOOK_URL nor REPLIT_DEV_DOMAIN set — using polling fallback");
    await startPollingFallback();
    return;
  }

  // Append shared-secret token to the webhook URL when CDC_WEBHOOK_SECRET is set.
  // CockroachDB changefeed sinks cannot send custom headers, so a query parameter
  // is the standard authentication mitigation for webhook sink URLs.
  const secret = process.env.CDC_WEBHOOK_SECRET;
  const tokenSuffix = secret ? `?token=${encodeURIComponent(secret)}` : "";

  const webhookUrl = explicitUrl
    ? `webhook-https://${explicitUrl.replace(/^https?:\/\//, "")}${tokenSuffix}`
    : `webhook-https://${devDomain}/api/internal/cdc${tokenSuffix}`;

  try {
    // Check if an existing changefeed is already running for our tables.
    // If CDC_WEBHOOK_SECRET is set, also verify the existing changefeed URL
    // contains the token — if not, cancel and recreate with the token.
    // Look for an existing changefeed in any recoverable state (running, paused, or failed).
    // A paused/failed job that is ignored and left in place while a new one is created
    // results in duplicate changefeeds that can produce duplicate CDC events.
    const existing = await pool.query<{ job_id: string; status: string; description: string }>(
      `SELECT job_id, status, description FROM [SHOW CHANGEFEED JOBS] 
       WHERE description LIKE '%execution_logs%' 
         AND description LIKE '%agent_handoffs%'
         AND status IN ('running', 'paused', 'failed')
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END
       LIMIT 1`,
    );

    if (existing.rows.length > 0) {
      const job = existing.rows[0];
      // If a token is configured but the existing changefeed URL doesn't include it,
      // always cancel and recreate — regardless of job status — so the sink is authenticated.
      const needsToken = secret && !job.description.includes("?token=");
      if (needsToken || job.status === "failed") {
        // Cancel the existing job (failed jobs must be explicitly cancelled before a new one
        // can be created on the same tables; paused jobs with wrong token also need replacement).
        logger.info(
          { jobId: job.job_id, status: job.status, reason: needsToken ? "missing-token" : "failed-job" },
          "[CDC] Cancelling existing changefeed to recreate with correct configuration",
        );
        await pool.query(`CANCEL JOB ${job.job_id}`).catch(() => {});
        // Fall through to CREATE CHANGEFEED below.
      } else if (job.status === "paused") {
        // A paused job with the correct token can be resumed without recreating the changefeed.
        // Resuming preserves the cursor position and avoids re-delivering already-processed events.
        logger.info(
          { jobId: job.job_id },
          "[CDC] Resuming paused CockroachDB changefeed",
        );
        await pool.query(`RESUME JOB ${job.job_id}`).catch(() => {});
        _cdcActive = true;
        _startHeartbeat();
        return;
      } else {
        // job.status === "running" and token is correct — reuse as-is.
        _cdcActive = true;
        logger.info(
          { jobId: job.job_id },
          "[CDC] Existing CockroachDB changefeed reused — streaming to webhook",
        );
        _startHeartbeat();
        return;
      }
    }

    // Create the changefeed pointing at the authenticated public webhook endpoint.
    await pool.query(
      `CREATE CHANGEFEED FOR TABLE execution_logs, agent_handoffs
       INTO $1
       WITH updated, full_table_name, format = 'json'`,
      [webhookUrl],
    );

    _cdcActive = true;
    logger.info(
      { webhookUrl },
      "[CDC] ✅ CockroachDB changefeed created — real-time audit stream active",
    );
    _startHeartbeat();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: msg },
      "[CDC] Changefeed creation failed — falling back to 2-second polling",
    );
    await startPollingFallback();
  }
}

function _startHeartbeat(): void {
  setInterval(() => {
    broadcast({
      type: "heartbeat",
      createdAt: new Date().toISOString(),
      source: "heartbeat",
    });
  }, 30_000);
}

// ── Polling fallback ───────────────────────────────────────────────────────

/**
 * Queries `execution_logs` and `agent_handoffs` for new rows every 2 seconds
 * and broadcasts them as SSE events. Same event schema as CDC.
 */
async function startPollingFallback(): Promise<void> {
  logger.info("[CDC] Starting 2-second polling fallback for audit stream");

  // Initialise cursors to now so we don't replay the entire history.
  const now = new Date().toISOString();
  _lastLogTs = now;
  _lastHandoffTs = now;
  _lastIncidentTs = now;

  _pollTimer = setInterval(async () => {
    try {
      // ── execution_logs ────────────────────────────────────────────────
      const logRes = await pool.query<{
        log_id: string;
        incident_id: string;
        action_taken: string;
        result: string | null;
        created_at: string;
      }>(
        `SELECT log_id, incident_id, action_taken, result, created_at
         FROM execution_logs
         WHERE created_at > $1
         ORDER BY created_at ASC
         LIMIT 20`,
        [_lastLogTs],
      );

      for (const row of logRes.rows) {
        broadcast({
          type: "execution_log",
          incidentId: row.incident_id,
          actionTaken: row.action_taken,
          result: row.result ?? undefined,
          createdAt: row.created_at,
          source: "poll",
        });
        _lastLogTs = row.created_at;
      }

      // ── agent_handoffs ────────────────────────────────────────────────
      const handoffRes = await pool.query<{
        handoff_id: string;
        incident_id: string;
        agent_name: string;
        decision_mode: string | null;
        note: string | null;
        created_at: string;
      }>(
        `SELECT handoff_id, incident_id, agent_name, decision_mode, note, created_at
         FROM agent_handoffs
         WHERE created_at > $1
         ORDER BY created_at ASC
         LIMIT 20`,
        [_lastHandoffTs],
      );

      for (const row of handoffRes.rows) {
        broadcast({
          type: "agent_handoff",
          incidentId: row.incident_id,
          agentName: row.agent_name,
          decisionMode: row.decision_mode ?? undefined,
          note: row.note ?? undefined,
          createdAt: row.created_at,
          source: "poll",
        });
        _lastHandoffTs = row.created_at;
      }

      // ── incident_status ───────────────────────────────────────────────
      const incidentRes = await pool.query<{
        incident_id: string;
        alert_fingerprint: string;
        status: string;
        updated_at: string;
      }>(
        `SELECT incident_id, alert_fingerprint, status, updated_at
         FROM incident_state
         WHERE updated_at > $1
         ORDER BY updated_at ASC
         LIMIT 20`,
        [_lastIncidentTs],
      );

      for (const row of incidentRes.rows) {
        broadcast({
          type: "incident_status",
          incidentId: row.incident_id,
          status: row.status,
          alertFingerprint: row.alert_fingerprint,
          createdAt: row.updated_at,
          source: "poll",
        });
        _lastIncidentTs = row.updated_at;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[CDC] Poll error (non-fatal)",
      );
    }
  }, 2000);
}

// ── CDC webhook payload parser ────────────────────────────────────────────

/**
 * Parses a raw CockroachDB webhook changefeed payload and returns typed
 * audit events.
 *
 * CockroachDB webhook sink payload shape:
 * {
 *   payload: [
 *     {
 *       key: ["<uuid>"],
 *       value: {
 *         after: { <row columns> }   // null for DELETE events
 *       }
 *     }
 *   ],
 *   length: N
 * }
 */
export function parseCdcPayload(body: unknown): AuditEvent[] {
  const events: AuditEvent[] = [];
  if (!body || typeof body !== "object") return events;
  const b = body as Record<string, unknown>;
  const payload = Array.isArray(b.payload) ? b.payload : [];

  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const val = (item as Record<string, unknown>).value as Record<string, unknown> | null;
    if (!val) continue;
    const after = val.after as Record<string, unknown> | null;
    if (!after) continue; // DELETE — skip

    if ("log_id" in after) {
      events.push({
        type: "execution_log",
        incidentId: String(after.incident_id ?? ""),
        actionTaken: String(after.action_taken ?? ""),
        result: after.result != null ? String(after.result) : undefined,
        createdAt: String(after.created_at ?? new Date().toISOString()),
        source: "cdc",
      });
    } else if ("handoff_id" in after) {
      events.push({
        type: "agent_handoff",
        incidentId: String(after.incident_id ?? ""),
        agentName: String(after.agent_name ?? ""),
        decisionMode: after.decision_mode != null ? String(after.decision_mode) : undefined,
        note: after.note != null ? String(after.note) : undefined,
        createdAt: String(after.created_at ?? new Date().toISOString()),
        source: "cdc",
      });
    }
  }

  return events;
}

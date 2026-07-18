/**
 * Audit stream routes.
 *
 * GET /api/stream/audit    — Server-Sent Events endpoint (live audit stream).
 *                            Backed by CockroachDB CDC changefeed when
 *                            available, otherwise 2-second polling fallback.
 *
 *   Auth: `Authorization: Bearer <jwt>` header  OR  `?token=<jwt>` query param.
 *   EventSource (browser) cannot set custom headers, so the dashboard passes
 *   the session JWT as ?token= in the URL instead.
 *
 * POST /api/internal/cdc   — CDC webhook receiver. CockroachDB pushes
 *                            changefeed events here via the webhook-https://
 *                            sink. Secured by shared-secret ?token= param
 *                            (CDC_WEBHOOK_SECRET); no JWT auth here.
 */

import { Router, type IRouter } from "express";
import { jwtVerify } from "jose";
import {
  addSseSubscriber,
  removeSseSubscriber,
  broadcast,
  parseCdcPayload,
  isCdcActive,
} from "../lib/cdc";

const router: IRouter = Router();

function getSecret(): Uint8Array | null {
  const s = process.env.SESSION_SECRET;
  return s ? new TextEncoder().encode(s) : null;
}

// ── SSE audit stream — GET /api/stream/audit ──────────────────────────────

router.get("/stream/audit", async (req, res): Promise<void> => {
  const secret = getSecret();
  const staticKey = process.env.CLOUD_SURGEON_API_KEY;

  // Resolve credential: ?token= (browser EventSource) or Authorization: Bearer
  const tokenParam = typeof req.query["token"] === "string" ? req.query["token"] : null;
  const authHeader = req.headers["authorization"] ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const jwt = tokenParam ?? bearerToken;

  // Also accept x-api-key for server-side / legacy clients
  const apiKey = req.headers["x-api-key"];

  let authed = false;

  if (staticKey && apiKey === staticKey) {
    authed = true;
  } else if (jwt && secret) {
    try {
      await jwtVerify(jwt, secret);
      authed = true;
    } catch {
      // invalid JWT — fall through
    }
  } else if (!staticKey && !secret) {
    // No auth configured — open in dev mode
    authed = true;
  }

  if (!authed) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Set SSE headers — disable buffering at every layer.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  addSseSubscriber(res);

  // Send connection metadata as the first event so the client knows the
  // stream mode (CDC vs polling) without an extra HTTP call.
  const init = JSON.stringify({
    type: "connected",
    cdcActive: isCdcActive(),
    streamMode: isCdcActive() ? "cockroachdb-changefeed" : "polling-fallback",
    message: isCdcActive()
      ? "🟢 Connected to CockroachDB CDC changefeed — real-time audit events via CRDB webhook sink"
      : "🔵 Connected to polling fallback (2 s interval) — changefeed not available in this cluster tier",
    createdAt: new Date().toISOString(),
    source: isCdcActive() ? ("cdc" as const) : ("poll" as const),
  });
  res.write(`data: ${init}\n\n`);

  // Per-connection heartbeat every 25 s (proxy timeout guard).
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          type: "heartbeat",
          createdAt: new Date().toISOString(),
          source: "heartbeat",
        })}\n\n`,
      );
    } else {
      clearInterval(heartbeat);
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeSseSubscriber(res);
  });
});

// ── CDC webhook receiver — POST /api/internal/cdc ─────────────────────────
//
// Authentication: shared-secret token in query string (?token=<CDC_WEBHOOK_SECRET>).
// The changefeed sink URL includes this token so every push is authenticated.
// CockroachDB's basic webhook sink cannot send custom headers, so a URL query
// parameter is the standard mitigation for unauthenticated sink URLs.
//
// If CDC_WEBHOOK_SECRET is not set (local dev), validation is skipped so
// the fallback polling mode and manual testing continue to work.

router.post("/internal/cdc", (req, res): void => {
  const expectedToken = process.env.CDC_WEBHOOK_SECRET;
  if (expectedToken) {
    const provided = req.query["token"];
    if (provided !== expectedToken) {
      res.status(401).json({ error: "Unauthorized — invalid CDC webhook token" });
      return;
    }
  }

  const events = parseCdcPayload(req.body);
  for (const event of events) {
    broadcast(event);
  }
  // CockroachDB requires a 2xx within the webhook timeout window.
  res.status(200).json({ received: events.length });
});

export default router;

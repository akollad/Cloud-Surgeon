import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";

function getSecret(): Uint8Array | null {
  const s = process.env.SESSION_SECRET;
  return s ? new TextEncoder().encode(s) : null;
}

/**
 * Accepts either:
 *  1. `x-api-key: <CLOUD_SURGEON_API_KEY>` — server-to-server / legacy clients
 *  2. `Authorization: Bearer <jwt>` — dashboard JWT issued by POST /api/auth/token
 *
 * Fails closed (503) when neither CLOUD_SURGEON_API_KEY nor SESSION_SECRET is set.
 */
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const staticKey = process.env.CLOUD_SURGEON_API_KEY;
  const secret = getSecret();

  if (!staticKey && !secret) {
    res.status(503).json({ error: "Auth not configured on server (missing CLOUD_SURGEON_API_KEY and SESSION_SECRET)" });
    return;
  }

  // 1. Static API key (x-api-key header)
  const providedKey = req.header("x-api-key");
  if (staticKey && providedKey === staticKey) {
    next();
    return;
  }

  // 2. Bearer JWT (Authorization header)
  const authHeader = req.header("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (bearerToken && secret) {
    try {
      await jwtVerify(bearerToken, secret);
      next();
      return;
    } catch {
      // fall through to 401
    }
  }

  res.status(401).json({ error: "Unauthorized: provide a valid x-api-key header or Bearer token" });
}

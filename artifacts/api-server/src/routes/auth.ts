/**
 * Auth routes.
 *
 * POST /api/auth/token  — exchange dashboard password for a short-lived JWT.
 *                         Public endpoint (no x-api-key required).
 *
 * The JWT is signed with SESSION_SECRET (HS256, 1-hour TTL).
 * The dashboard stores it in sessionStorage and sends it as
 * `Authorization: Bearer <token>` on every request; the SSE endpoint
 * accepts it as a `?token=` query param because EventSource cannot set headers.
 */

import { Router, type IRouter } from "express";
import { SignJWT } from "jose";

const router: IRouter = Router();

function getSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return new TextEncoder().encode(s);
}

router.post("/auth/token", async (req, res): Promise<void> => {
  const password = req.body?.password;
  const expected = process.env.DASHBOARD_PASSWORD;

  // If no password is configured, the gate is a no-op — return a token immediately.
  // This keeps local / demo environments working without configuration.
  if (expected && password !== expected) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  try {
    const secret = getSecret();
    const token = await new SignJWT({ role: "dashboard" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);

    res.json({ token, expiresIn: 3600 });
  } catch (err) {
    res.status(503).json({ error: "Token signing unavailable — SESSION_SECRET not configured" });
  }
});

export default router;

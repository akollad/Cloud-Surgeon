import type { NextFunction, Request, Response } from "express";

// Simple API key auth shared between the Streamlit dashboard and this service.
// Without this, anyone who knows the service URL can trigger/read incidents —
// unacceptable even for a demo, and explicitly flagged as a "production readiness" gap.
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.CLOUD_SURGEON_API_KEY;
  if (!expected) {
    // If the key is not configured, fail-closed rather than opening
    // the API without protection.
    res.status(503).json({ error: "API key not configured on server" });
    return;
  }

  const provided = req.header("x-api-key");
  if (provided !== expected) {
    res.status(401).json({ error: "Unauthorized: missing or invalid x-api-key header" });
    return;
  }

  next();
}

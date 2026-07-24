/**
 * Chaos engineering routes
 *
 * POST /api/chaos/sigkill
 *   Kills the running Node process with SIGKILL after a short delay.
 *   Used by the dashboard to trigger a real process crash from the UI,
 *   without manual terminal manipulation — identical to what an OOMKiller
 *   or ECS/Lambda orchestrator would do when force-killing a task.
 *
 *   The Replit workflow manager automatically restarts the service (like
 *   a Lambda orchestrator restarting a function after a crash).
 *   The dashboard can then re-trigger the same incident and prove that
 *   recovery from CockroachDB is lossless.
 *
 * SECURITY:
 *   - Protected by apiKeyAuth (CLOUD_SURGEON_API_KEY).
 *   - Additionally gated by CHAOS_ENABLED=true env var — the route returns
 *     403 unless explicitly enabled. Never set this in production deployments.
 *   - Optionally further restricted by CHAOS_API_KEY: if that env var is set,
 *     the caller must supply it as X-Chaos-Key header (separate from the main key).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth";

const router: IRouter = Router();

router.use(apiKeyAuth);

router.post("/chaos/sigkill", (req: Request, res: Response): void => {
  // Gate 1: explicit opt-in via environment variable
  if (process.env.CHAOS_ENABLED !== "true") {
    res.status(403).json({
      error: "Chaos engineering is disabled. Set CHAOS_ENABLED=true to enable this endpoint.",
    });
    return;
  }

  // Gate 2: optional secondary key for an extra layer of protection
  const chaosKey = process.env.CHAOS_API_KEY;
  if (chaosKey) {
    const provided = req.headers["x-chaos-key"];
    if (provided !== chaosKey) {
      res.status(403).json({
        error: "Invalid or missing X-Chaos-Key header.",
      });
      return;
    }
  }

  req.log.warn("CHAOS: SIGKILL requested via dashboard — process will die in 300ms");

  // Respond immediately before dying, so the dashboard receives
  // confirmation before the connection drops.
  res.status(202).json({
    message: "SIGKILL scheduled — process will die in ~300ms. Workflow manager will restart it.",
    pid: process.pid,
    note: "Re-trigger the same incident after restart to prove stateful resumption from CockroachDB.",
  });

  // Exit with code 1 after the response delay.
  // process.exit(1) is detected by the Replit workflow runner as a crash
  // and triggers an automatic restart — identical effect to SIGKILL but
  // more reliably caught by managed process supervisors.
  setTimeout(() => {
    process.exit(1);
  }, 300);
});

export default router;

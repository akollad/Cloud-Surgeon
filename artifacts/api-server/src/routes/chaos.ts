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
 * SECURITY: this route is protected by apiKeyAuth (same key as all
 *   incident routes). In production it would be disabled or restricted
 *   to an internal network.
 */
import { Router, type IRouter } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth";

const router: IRouter = Router();

router.use(apiKeyAuth);

router.post("/chaos/sigkill", (req, res): void => {
  req.log.warn("CHAOS: SIGKILL requested via dashboard — process will die in 300ms");

  // Respond immediately before dying, so the dashboard receives
  // confirmation before the connection drops.
  res.status(202).json({
    message: "SIGKILL scheduled — process will die in ~300ms. Workflow manager will restart it.",
    pid: process.pid,
    note: "Re-trigger the same incident after restart to prove stateful resumption from CockroachDB.",
  });

  // Kill the process after the response delay
  setTimeout(() => {
    process.kill(process.pid, "SIGKILL");
  }, 300);
});

export default router;

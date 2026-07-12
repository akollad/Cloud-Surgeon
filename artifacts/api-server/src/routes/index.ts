import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chaosRouter from "./chaos";
import incidentsRouter from "./incidents";
import metricsRouter from "./metrics";
import webhookRouter from "./webhook";

const router: IRouter = Router();

router.use(healthRouter);

// Webhook CloudWatch/SNS mounted BEFORE incidentsRouter — the latter applies
// apiKeyAuth to everything that passes through it (no path prefix), so the
// webhook would be blocked if mounted after. The webhook is secured by
// SNS format validation; API key auth is not compatible with SNS HTTP subscriptions.
router.use(webhookRouter);

// metricsRouter and chaosRouter before incidentsRouter for the same reason
// (apiKeyAuth is global in incidentsRouter; others apply their own).
router.use(metricsRouter);
router.use(chaosRouter);
router.use(incidentsRouter);

export default router;

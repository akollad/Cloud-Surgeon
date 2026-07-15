import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chaosRouter from "./chaos";
import incidentsRouter from "./incidents";
import metricsRouter from "./metrics";
import webhookRouter from "./webhook";
import streamRouter from "./stream";
import setupRouter from "./setup";

const router: IRouter = Router();

router.use(healthRouter);
router.use(setupRouter);

// Webhook CloudWatch/SNS mounted BEFORE incidentsRouter — the latter applies
// apiKeyAuth to everything that passes through it (no path prefix), so the
// webhook would be blocked if mounted after. The webhook is secured by
// SNS format validation; API key auth is not compatible with SNS HTTP subscriptions.
router.use(webhookRouter);

// streamRouter before incidentsRouter: SSE connections and CDC webhook receiver
// need their own auth logic (SSE: X-API-Key header; CDC: no auth from CRDB).
router.use(streamRouter);

// metricsRouter and chaosRouter before incidentsRouter for the same reason
// (apiKeyAuth is global in incidentsRouter; others apply their own).
router.use(metricsRouter);
router.use(chaosRouter);
router.use(incidentsRouter);

export default router;

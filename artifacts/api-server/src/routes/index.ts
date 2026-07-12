import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chaosRouter from "./chaos";
import incidentsRouter from "./incidents";
import metricsRouter from "./metrics";
import webhookRouter from "./webhook";

const router: IRouter = Router();

router.use(healthRouter);

// Webhook CloudWatch/SNS monté AVANT incidentsRouter — ce dernier applique
// apiKeyAuth à tout ce qui le traverse (pas de préfixe de chemin), donc le
// webhook serait bloqué s'il était monté après. Le webhook est sécurisé par
// la validation du format SNS ; l'auth par clé API n'est pas compatible avec
// les subscriptions HTTP SNS.
router.use(webhookRouter);

// metricsRouter et chaosRouter avant incidentsRouter pour la même raison
// (apiKeyAuth global est dans incidentsRouter ; les autres appliquent leur propre).
router.use(metricsRouter);
router.use(chaosRouter);
router.use(incidentsRouter);

export default router;

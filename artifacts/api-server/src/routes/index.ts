import { Router, type IRouter } from "express";
import healthRouter from "./health";
import incidentsRouter from "./incidents";

const router: IRouter = Router();

router.use(healthRouter);
router.use(incidentsRouter);

export default router;

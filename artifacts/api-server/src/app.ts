import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// ── Security headers (OWASP baseline) ─────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────
// In production, lock to the dashboard's origin via DASHBOARD_ORIGIN env var.
// In dev (unset), allow any origin so local testing remains frictionless.
const allowedOrigin = process.env.DASHBOARD_ORIGIN;
app.use(
  cors(
    allowedOrigin
      ? { origin: allowedOrigin, credentials: true }
      : undefined, // open CORS in dev
  ),
);

// ── HTTP request logging ───────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting on mutating / expensive endpoints ────────────────────────
// 100 requests per 15-minute window per IP — prevents abuse while allowing
// rapid iteration during the demo without touching read endpoints.
const triggerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — rate limit exceeded. Try again in 15 minutes." },
});

app.use("/api/incidents/trigger", triggerLimiter);
app.use("/api/webhook/cloudwatch", triggerLimiter);

// ── Routes ────────────────────────────────────────────────────────────────
app.use("/api", router);

export default app;

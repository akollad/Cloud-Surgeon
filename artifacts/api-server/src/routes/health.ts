import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { generateEmbedding } from "../lib/embeddings";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * GET /api/healthz/embedding
 *
 * Reports which embedding provider is currently active.
 * Runs a short probe so the caller sees the real provider, not a config claim.
 * Useful for verifying that Voyage AI / Bedrock Titan are reachable before
 * recording demo metrics — if provider is "keyword-infra", vector similarity
 * results are domain-heuristic rather than fully semantic.
 */
router.get("/healthz/embedding", async (_req, res) => {
  try {
    const { provider } = await generateEmbedding("health check probe");
    const semantic = provider !== "keyword-infra";
    res.json({
      provider,
      semantic,
      note: semantic
        ? "Full semantic embeddings active — vector similarity is meaningful."
        : "Keyword-infra fallback active — Voyage AI and Bedrock Titan are unreachable. " +
          "Vector routing operates on domain-heuristic embeddings, not learned semantics. " +
          "Set VOYAGE_API_KEY to restore full semantic search.",
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;

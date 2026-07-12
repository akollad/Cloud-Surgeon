import app from "./app";
import { logger } from "./lib/logger";
import { seedVectorMemory } from "./lib/seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Initialiser la mémoire vectorielle au démarrage (idempotent)
  try {
    const seedResult = await seedVectorMemory();
    if (seedResult.seeded) {
      logger.info({ count: seedResult.count }, "Vector memory seeded with synthetic incidents");
    }
  } catch (seedErr) {
    // Non bloquant : le seed peut échouer si la DB est temporairement
    // indisponible au démarrage, sans empêcher le service de démarrer.
    logger.warn({ err: seedErr }, "Vector memory seed failed (non-fatal)");
  }
});

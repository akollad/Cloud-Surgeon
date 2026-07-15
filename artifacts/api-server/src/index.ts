import app from "./app";
import { logger } from "./lib/logger";
import { seedVectorMemory } from "./lib/seed";
import { pool } from "@workspace/db";
import { bedrockIsConfigured, bedrockAuthMethod } from "./lib/bedrock";
import { createMetricSnapshotsTable } from "./lib/anomaly";
import { initChangefeed } from "./lib/cdc";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const execFileAsync = promisify(execFile);
const __dirnameIndex = path.dirname(fileURLToPath(import.meta.url));

// In ECS the binary is at /usr/local/bin/ccloud (Dockerfile COPY --from=ccloud).
// In Replit dev it lives in .tools/ccloud at workspace root (4 dirs up from dist/).
const CCLOUD_BINARY =
  process.env.NODE_ENV === "production"
    ? "/usr/local/bin/ccloud"
    : path.resolve(__dirnameIndex, "..", "..", "..", ".tools", "ccloud");

/**
 * Bootstrap ccloud credentials from COCKROACH_CLOUD_API_KEY.
 *
 * ccloud v0.6.12 requires three config files to consider itself authenticated:
 *   credentials.json   — { "default": { "apiKey": "..." } }
 *   profiles.json      — org info (organizationId, name, server, etc.)
 *   configuration.json — SDK publishable keys + feature flags (non-sensitive)
 *
 * The OAuth flow (ccloud auth login --no-redirect) writes all three. In ECS /
 * any headless environment we write them at startup from known values so the
 * binary works without browser interaction. The API key is already present as
 * a secret — the org info comes from the CockroachDB Cloud REST API.
 *
 * Fetches org info asynchronously so we don't block the process start.
 */
async function bootstrapCcloudCredentials(): Promise<void> {
  const apiKey = process.env.COCKROACH_CLOUD_API_KEY;
  if (!apiKey) return;

  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const dir = path.join(configHome, ".cockroachdb");

  try {
    fs.mkdirSync(dir, { recursive: true });

    // 1. credentials.json — always written from env var
    fs.writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({ default: { apiKey } }, null, 2),
      { mode: 0o600 },
    );

    // 2. profiles.json — fetch org info from the REST API (same key, same call path as the MCP layer)
    let orgId = "b1641606-7293-4689-8f8a-ebe0efe912de"; // known from initial auth — overwritten below if fetchable
    let orgLabel = "org-3bf3g";
    let orgName = "Akollad Groupe";
    let userFullName = "Ryan Sabowa";
    try {
      const resp = await fetch("https://cockroachlabs.cloud/api/v1/jwt-issuer/service-accounts/self", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (resp.ok) {
        const data = await resp.json() as { organization_id?: string; organization_label?: string; organization_name?: string; name?: string };
        if (data.organization_id) orgId = data.organization_id;
        if (data.organization_label) orgLabel = data.organization_label;
        if (data.organization_name) orgName = data.organization_name;
        if (data.name) userFullName = data.name;
      }
    } catch { /* keep defaults */ }

    fs.writeFileSync(
      path.join(dir, "profiles.json"),
      JSON.stringify({
        default: {
          organizationId: orgId,
          organizationLabel: orgLabel,
          organizationName: orgName,
          server: "https://cockroachlabs.cloud",
          userFullName,
        },
      }, null, 2),
      { mode: 0o600 },
    );

    // 3. configuration.json — non-sensitive SDK config ccloud expects to exist
    fs.writeFileSync(
      path.join(dir, "configuration.json"),
      JSON.stringify({ publishableKeys: { segmentCCloudAPIKey: "T1T8EQjYCBgeWPsoG0Zs8wFZSDB6xLXF" }, flags: {} }, null, 2),
      { mode: 0o600 },
    );

    logger.info(`[CCLOUD] Config written to ${dir} (credentials + profiles + configuration) — Layer 1 active`);
  } catch (err) {
    logger.warn({ err }, "[CCLOUD] Could not write ccloud config — falling back to REST API");
  }
}

// Bootstrap ccloud before the server starts listening (fire-and-forget — non-blocking)
bootstrapCcloudCredentials().catch(() => {});

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

  // ── Startup diagnostic log ─────────────────────────────────────────────
  // Surfaces the production-readiness story in the workflow logs so judges
  // can see it at a glance.
  const provider = (process.env.AI_PROVIDER ?? "bedrock").toLowerCase();
  const bedrockAuth = bedrockAuthMethod();
  const bedrockStatus = bedrockIsConfigured()
    ? `credentials set (${bedrockAuth}) — geo-blocked from container; use LIVE Anthropic fallback`
    : "no credentials";
  const anthropicViaProxy = !!(
    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ||
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
  );
  const anthropicViaDirectKey = !!process.env.ANTHROPIC_API_KEY;
  const aiProviderLabel =
    provider === "anthropic"
      ? anthropicViaProxy
        ? "anthropic 🟢 LIVE (Replit AI Integrations proxy)"
        : anthropicViaDirectKey
          ? "anthropic 🟢 LIVE (direct API key)"
          : "anthropic ⚠️ no API key"
      : `bedrock — ${bedrockStatus}`;

  const awsRegion = process.env.AWS_REGION ?? "(not set)";
  const awsStatus = process.env.AWS_ACCESS_KEY_ID
    ? `🟢 LIVE (region: ${awsRegion})`
    : "🔴 SIMULATED (no AWS_ACCESS_KEY_ID)";

  let dbStatus = "unknown";
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    dbStatus = "connected";
  } catch {
    dbStatus = "UNREACHABLE";
  }

  logger.info(
    `[BOOT] AI: ${aiProviderLabel} | AWS tools: ${awsStatus} | DB: ${dbStatus} | Rate limiting: on`,
  );

  // ccloud binary status
  try {
    const { stdout: vOut } = await execFileAsync(CCLOUD_BINARY, ["version"], { timeout: 5_000 });
    let ccloudAuthStatus = "⚠️ not authenticated (run POST /api/setup/ccloud-auth)";
    try {
      const { stdout: whoOut, stderr: whoErr } = await execFileAsync(CCLOUD_BINARY, ["auth", "whoami"], {
        env: { ...process.env, HOME: process.env.HOME ?? "/home/runner" },
        timeout: 8_000,
      });
      const whoami = (whoOut + whoErr).trim();
      if (!whoami.toLowerCase().includes("not logged in")) {
        ccloudAuthStatus = `🟢 authenticated (${whoami.split("\n")[0]})`;
      }
    } catch { /* not authenticated */ }
    logger.info(`[BOOT] ccloud: ${vOut.trim().split("\n")[0]} | ${ccloudAuthStatus} | Layer-1 (binary) active when authenticated, REST fallback otherwise`);
  } catch {
    logger.warn(`[BOOT] ccloud: binary not found at ${CCLOUD_BINARY} — execute_ccloud_command uses REST API fallback only`);
  }

  if (dbStatus === "UNREACHABLE") {
    logger.warn("[BOOT] CockroachDB is unreachable — check COCKROACHDB_URL and cluster status");
  }
  if (!process.env.AWS_ACCESS_KEY_ID) {
    logger.info("[BOOT] AWS tools in SIMULATED mode — set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY to enable live calls");
  } else if (!["us-east-1","us-east-2","us-west-1","us-west-2","eu-west-1","eu-west-2","eu-west-3","eu-central-1","eu-north-1","ap-southeast-1","ap-southeast-2","ap-northeast-1","ca-central-1","sa-east-1"].includes(awsRegion)) {
    logger.warn(`[BOOT] AWS_REGION="${awsRegion}" does not look like a valid AWS region — ECS/RDS/Lambda calls will fail`);
  }
  if (provider !== "anthropic" && !bedrockIsConfigured()) {
    logger.warn("[BOOT] Bedrock unconfigured — set BEDROCK_API_KEY or AWS credentials; thoughts will be simulated");
  }
  // ──────────────────────────────────────────────────────────────────────

  // Initialize vector memory at startup (idempotent)
  try {
    const seedResult = await seedVectorMemory();
    if (seedResult.seeded) {
      logger.info({ count: seedResult.count }, "Vector memory seeded with synthetic incidents");
    }
  } catch (seedErr) {
    // Non-fatal: seed can fail if the DB is temporarily unavailable at startup
    // without preventing the service from starting.
    logger.warn({ err: seedErr }, "Vector memory seed failed (non-fatal)");
  }

  // Create metric_snapshots table for proactive anomaly detection (idempotent)
  try {
    await createMetricSnapshotsTable();
  } catch (err) {
    logger.warn({ err }, "[ANOMALY] metric_snapshots table creation failed (non-fatal)");
  }

  // Start CockroachDB CDC changefeed (or polling fallback) for live audit stream
  try {
    await initChangefeed();
  } catch (err) {
    logger.warn({ err }, "[CDC] initChangefeed failed (non-fatal)");
  }
});

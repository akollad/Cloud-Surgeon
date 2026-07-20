// ============================================================================
// Tests — Routing, calibration, and strategy detection
//
// Covers computeRoutingMode (Layer 2) and detectStrategy (Layer 1) which are
// the two deterministic functions that gate whether the agent acts
// autonomously or pauses for human approval.
// ============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRoutingMode } from "./calibration.js";
import { detectStrategy, fingerprint } from "./memory.js";

// ── computeRoutingMode ────────────────────────────────────────────────────

describe("computeRoutingMode", () => {
  it("returns EXPLORATORY for default_repair regardless of win-rate", () => {
    assert.equal(computeRoutingMode("default_repair", 0.1, 0.95, 100), "EXPLORATORY");
  });

  it("returns PENDING_APPROVAL when sample count < 3 (optimistic prior cannot grant autonomy)", () => {
    assert.equal(computeRoutingMode("ecs_service_restart", 0.05, 0.90, 0), "PENDING_APPROVAL");
    assert.equal(computeRoutingMode("ecs_service_restart", 0.05, 0.90, 2), "PENDING_APPROVAL");
  });

  it("returns AUTONOMOUS when win-rate > 80% and sample count ≥ 3", () => {
    assert.equal(computeRoutingMode("ecs_service_restart", 0.1, 0.85, 10), "AUTONOMOUS");
    assert.equal(computeRoutingMode("lambda_concurrency_scale", undefined, 0.81, 5), "AUTONOMOUS");
  });

  it("returns PENDING_APPROVAL when win-rate ≤ 80% even with many samples", () => {
    assert.equal(computeRoutingMode("rds_cpu_throttle", 0.2, 0.79, 50), "PENDING_APPROVAL");
    assert.equal(computeRoutingMode("ecs_service_restart", 0.3, 0.50, 20), "PENDING_APPROVAL");
  });

  it("returns PENDING_APPROVAL when win-rate is undefined (no history)", () => {
    assert.equal(computeRoutingMode("ecs_service_restart", undefined, undefined, 3), "PENDING_APPROVAL");
  });

  it("boundary: win-rate exactly 0.80 returns PENDING_APPROVAL (must be strictly > 0.8)", () => {
    assert.equal(computeRoutingMode("ecs_service_restart", 0.1, 0.80, 10), "PENDING_APPROVAL");
  });

  it("boundary: win-rate 0.801 returns AUTONOMOUS", () => {
    assert.equal(computeRoutingMode("ecs_service_restart", 0.1, 0.801, 10), "AUTONOMOUS");
  });
});

// ── detectStrategy ────────────────────────────────────────────────────────

describe("detectStrategy", () => {
  it("detects ecs_service_restart from ECS CPU alert", () => {
    assert.equal(detectStrategy("ECS checkout-service CPU 92% — task count 2/5"), "ecs_service_restart");
  });

  it("detects lambda_concurrency_scale from throttle alert", () => {
    assert.equal(detectStrategy("Lambda order-processor ConcurrentExecutionLimitExceeded"), "lambda_concurrency_scale");
  });

  it("detects rds_cpu_throttle from RDS CPU alert", () => {
    assert.equal(detectStrategy("RDS prod-db CPU 95% sustained for 10 minutes"), "rds_cpu_throttle");
  });

  it("detects db_connection_pool_reset from max_connections alert", () => {
    assert.equal(detectStrategy("max_connections exhausted on prod-db — 500 active connections"), "db_connection_pool_reset");
  });

  it("detects crdb_hotspot_resolution from CockroachDB hot range alert", () => {
    assert.equal(detectStrategy("CockroachDB hot range detected on orders table — high contention"), "crdb_hotspot_resolution");
  });

  it("detects crdb_slow_query_termination from CRDB slow query alert", () => {
    assert.equal(detectStrategy("crdb slow query running for 120 seconds on analytics table"), "crdb_slow_query_termination");
  });

  it("detects crdb_changefeed_restart from changefeed paused alert", () => {
    assert.equal(detectStrategy("changefeed paused on inventory table — 5 minute lag"), "crdb_changefeed_restart");
  });

  it("detects iam_credential_rotation from AccessDenied alert", () => {
    assert.equal(detectStrategy("AccessDenied: s3:GetObject on arn:aws:s3:::prod-artifacts"), "iam_credential_rotation");
  });

  it("returns default_repair for unrecognised alert text", () => {
    assert.equal(detectStrategy("Unknown error on mystery-service"), "default_repair");
  });
});

// ── fingerprint ───────────────────────────────────────────────────────────

describe("fingerprint", () => {
  it("produces a 64-char hex SHA-256", () => {
    const fp = fingerprint("ECS checkout-service CPU 92%");
    assert.equal(fp.length, 64);
    assert.match(fp, /^[0-9a-f]+$/);
  });

  it("is deterministic — same input → same hash", () => {
    const a = fingerprint("ECS checkout-service CPU 92%");
    const b = fingerprint("ECS checkout-service CPU 92%");
    assert.equal(a, b);
  });

  it("trims whitespace before hashing", () => {
    assert.equal(fingerprint("  ECS alert  "), fingerprint("ECS alert"));
  });

  it("different inputs → different hashes (collision resistance)", () => {
    assert.notEqual(
      fingerprint("ECS checkout CPU 92%"),
      fingerprint("RDS prod-db CPU 95%"),
    );
  });
});

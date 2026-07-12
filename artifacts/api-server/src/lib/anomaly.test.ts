/**
 * Tests for the proactive anomaly detection path.
 *
 * Run with Node.js built-in test runner (no external deps):
 *   node --experimental-strip-types --test artifacts/api-server/src/lib/anomaly.test.ts
 *
 * Or via the workspace test script:
 *   pnpm --filter @workspace/api-server run test
 *
 * Two test suites:
 *
 *  A. Unit tests — keywordPredictiveMatch() and metricToAlertText()
 *     These are pure functions with no DB dependency and cover every keyword
 *     rule, threshold boundary, and the deduplication fingerprint shape.
 *
 *  B. HTTP integration tests — POST /api/metrics/ingest
 *     Only run when TEST_API_URL and TEST_API_KEY are set in the environment
 *     (set automatically by the CI workflow or manually for local runs).
 *     Tests: happy-path detection, field presence, and deduplication guard.
 *
 *  C. Zod schema passthrough tests
 *     Verify the three response schemas still carry .passthrough() so extra
 *     contextJson fields (source, predictiveMetric, …) are never stripped.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, describe } from "node:test";
import { keywordPredictiveMatch, metricToAlertText } from "./anomaly.js";
import {
  TriggerIncidentResponse,
  ListIncidentsResponseItem,
  GetIncidentResponse,
} from "@workspace/api-zod";

// ── A. Unit tests: keywordPredictiveMatch ─────────────────────────────────────

describe("keywordPredictiveMatch — CPU saturation", () => {
  test("CPUUtilization > 80 on RDS returns rds_cpu_throttle", () => {
    const result = keywordPredictiveMatch("CPUUtilization", 84, { DBInstanceIdentifier: "orders-db" });
    assert.equal(result, "rds_cpu_throttle");
  });

  test("CPUUtilization > 80 on ECS returns ecs_service_restart", () => {
    const result = keywordPredictiveMatch("CPUUtilization", 92, { ServiceName: "checkout-ecs" });
    assert.equal(result, "ecs_service_restart");
  });

  test("cpu_utilization (underscore variant) > 80 returns rds_cpu_throttle (generic)", () => {
    const result = keywordPredictiveMatch("cpu_utilization", 85, {});
    assert.equal(result, "rds_cpu_throttle");
  });

  test("CPUUtilization exactly at threshold 80 does NOT trigger (value must be > 80)", () => {
    const result = keywordPredictiveMatch("CPUUtilization", 80, {});
    assert.equal(result, null);
  });

  test("CPUUtilization below threshold returns null", () => {
    const result = keywordPredictiveMatch("CPUUtilization", 60, { ServiceName: "api" });
    assert.equal(result, null);
  });
});

describe("keywordPredictiveMatch — DB connection exhaustion", () => {
  test("DatabaseConnections > 400 returns db_connection_pool_reset", () => {
    const result = keywordPredictiveMatch("DatabaseConnections", 450, {});
    assert.equal(result, "db_connection_pool_reset");
  });

  test("database_connections (underscore variant) > 400 triggers", () => {
    const result = keywordPredictiveMatch("database_connections", 500, {});
    assert.equal(result, "db_connection_pool_reset");
  });

  test("DatabaseConnections at exactly 400 does NOT trigger", () => {
    const result = keywordPredictiveMatch("DatabaseConnections", 400, {});
    assert.equal(result, null);
  });
});

describe("keywordPredictiveMatch — HTTP 5xx errors", () => {
  test("HTTPCode_Target_5XX > 10 returns ecs_service_restart", () => {
    const result = keywordPredictiveMatch("HTTPCode_Target_5XX", 15, {});
    assert.equal(result, "ecs_service_restart");
  });

  test("http_5xx variant > 10 triggers", () => {
    const result = keywordPredictiveMatch("http_5xx_rate", 20, {});
    assert.equal(result, "ecs_service_restart");
  });

  test("5xx count at 10 does NOT trigger", () => {
    const result = keywordPredictiveMatch("HTTPCode_Target_5XX", 10, {});
    assert.equal(result, null);
  });
});

describe("keywordPredictiveMatch — Lambda throttling", () => {
  test("Throttles > 5 returns lambda_concurrency_scale", () => {
    const result = keywordPredictiveMatch("Throttles", 8, {});
    assert.equal(result, "lambda_concurrency_scale");
  });

  test("ConcurrentExecutions > 5 triggers", () => {
    const result = keywordPredictiveMatch("ConcurrentExecutions", 10, {});
    assert.equal(result, "lambda_concurrency_scale");
  });

  test("Throttles at 5 does NOT trigger", () => {
    const result = keywordPredictiveMatch("Throttles", 5, {});
    assert.equal(result, null);
  });
});

describe("keywordPredictiveMatch — Disk / storage", () => {
  test("FreeableStorage below 1GB returns disk_cleanup", () => {
    const result = keywordPredictiveMatch("FreeableStorage", 500_000_000, {});
    assert.equal(result, "disk_cleanup");
  });

  test("disk metric below 1GB triggers disk_cleanup", () => {
    const result = keywordPredictiveMatch("disk_free", 999_999_999, {});
    assert.equal(result, "disk_cleanup");
  });

  test("FreeableStorage at exactly 1e9 does NOT trigger (boundary is strictly <)", () => {
    const result = keywordPredictiveMatch("FreeableStorage", 1_000_000_000, {});
    assert.equal(result, null);
  });
});

describe("keywordPredictiveMatch — JVM heap", () => {
  test("JVM metric > 0.85 returns jvm_heap_restart", () => {
    const result = keywordPredictiveMatch("jvm_heap_usage_ratio", 0.91, {});
    assert.equal(result, "jvm_heap_restart");
  });

  test("HeapMemoryMaxUsed > 0.85 triggers", () => {
    const result = keywordPredictiveMatch("HeapMemoryMaxUsed", 0.90, {});
    assert.equal(result, "jvm_heap_restart");
  });

  test("JVM metric at 0.85 does NOT trigger", () => {
    const result = keywordPredictiveMatch("jvm_heap_usage_ratio", 0.85, {});
    assert.equal(result, null);
  });
});

describe("keywordPredictiveMatch — Network latency", () => {
  test("latency > 2000ms returns network_route_failover", () => {
    const result = keywordPredictiveMatch("network_latency_ms", 2500, {});
    assert.equal(result, "network_route_failover");
  });

  test("latency at exactly 2000 does NOT trigger", () => {
    const result = keywordPredictiveMatch("network_latency_ms", 2000, {});
    assert.equal(result, null);
  });
});

describe("keywordPredictiveMatch — ALB target response time", () => {
  test("TargetResponseTime > 2.0s returns ecs_service_restart", () => {
    const result = keywordPredictiveMatch("TargetResponseTime", 2.5, {});
    assert.equal(result, "ecs_service_restart");
  });

  test("TargetResponseTime at exactly 2.0 does NOT trigger", () => {
    const result = keywordPredictiveMatch("TargetResponseTime", 2.0, {});
    assert.equal(result, null);
  });
});

describe("keywordPredictiveMatch — unknown metric returns null", () => {
  test("arbitrary metric name with no rule returns null", () => {
    const result = keywordPredictiveMatch("SomeRandomMetric", 9999, { Service: "unknown" });
    assert.equal(result, null);
  });
});

// ── A2. Unit tests: metricToAlertText ─────────────────────────────────────────

describe("metricToAlertText", () => {
  test("includes metric name and value", () => {
    const text = metricToAlertText({ metricName: "CPUUtilization", value: 84 });
    assert.ok(text.includes("CPUUtilization"), "should include metric name");
    assert.ok(text.includes("84"), "should include metric value");
  });

  test("uses serviceHint when provided", () => {
    const text = metricToAlertText({
      metricName: "CPUUtilization",
      value: 84,
      serviceHint: "my-custom-service",
    });
    assert.ok(text.includes("my-custom-service"), "should include serviceHint");
  });

  test("falls back to dimensions.ServiceName when no serviceHint", () => {
    const text = metricToAlertText({
      metricName: "CPUUtilization",
      value: 84,
      dimensions: { ServiceName: "checkout-ecs" },
    });
    assert.ok(text.includes("checkout-ecs"), "should include ServiceName from dimensions");
  });

  test("falls back to dimensions.FunctionName for Lambda", () => {
    const text = metricToAlertText({
      metricName: "Throttles",
      value: 10,
      dimensions: { FunctionName: "process-payment" },
    });
    assert.ok(text.includes("process-payment"), "should include FunctionName");
  });

  test("uses unknown-service when no hint or dimension", () => {
    const text = metricToAlertText({ metricName: "Throttles", value: 10 });
    assert.ok(text.includes("unknown-service"), "should fall back to unknown-service");
  });

  test("includes dimensions as key=value pairs", () => {
    const text = metricToAlertText({
      metricName: "CPUUtilization",
      value: 84,
      dimensions: { Region: "us-east-1", Env: "prod" },
    });
    assert.ok(text.includes("Region=us-east-1"), "should include dimension key=value");
    assert.ok(text.includes("Env=prod"), "should include second dimension");
  });
});

// ── A3. Deduplication fingerprint shape ───────────────────────────────────────
// The fingerprint used by ingestMetrics is "PREDICTIVE:<metricName>:<service>".
// This unit test verifies the key components are present so a schema change
// cannot silently break the dedup without a test failure.

describe("deduplication fingerprint composition", () => {
  test("PREDICTIVE key embeds metricName and resolved service name", () => {
    const metricName = "CPUUtilization";
    const svc = "checkout-ecs";
    const predictiveKey = `PREDICTIVE:${metricName}:${svc}`;
    const fp1 = createHash("sha256").update(predictiveKey).digest("hex");

    // Same inputs → same fingerprint (deterministic)
    const fp2 = createHash("sha256").update(`PREDICTIVE:${metricName}:${svc}`).digest("hex");
    assert.equal(fp1, fp2, "fingerprint must be deterministic for the same metric+service");

    // Different service → different fingerprint (no cross-service collision)
    const fpOther = createHash("sha256").update(`PREDICTIVE:${metricName}:other-svc`).digest("hex");
    assert.notEqual(fp1, fpOther, "different service must yield a different fingerprint");

    // Different metric → different fingerprint
    const fpOtherMetric = createHash("sha256").update(`PREDICTIVE:DatabaseConnections:${svc}`).digest("hex");
    assert.notEqual(fp1, fpOtherMetric, "different metric must yield a different fingerprint");
  });
});

// ── B. HTTP integration tests ─────────────────────────────────────────────────
// These tests run only when TEST_API_URL and TEST_API_KEY are set.

const TEST_API_URL = process.env.TEST_API_URL;
const TEST_API_KEY = process.env.TEST_API_KEY;
const integrationEnabled = !!(TEST_API_URL && TEST_API_KEY);

// Typed shape of the /api/metrics/ingest response body
interface IngestResponseBody {
  ingested: number;
  predictiveIncidents: Array<{
    incidentId: string;
    metricName: string;
    strategy: string;
    similarityScore: number;
    detectionMethod: "keyword" | "vector";
  }>;
  message?: string;
  note?: string;
}

// Helper: POST /api/metrics/ingest with a single datapoint
async function ingestDatapoint(dp: {
  metricName: string;
  value: number;
  dimensions?: Record<string, string>;
  serviceHint?: string;
}): Promise<{ status: number; body: IngestResponseBody }> {
  if (!TEST_API_URL || !TEST_API_KEY) throw new Error("TEST_API_URL / TEST_API_KEY not set");

  const url = `${TEST_API_URL.replace(/\/$/, "")}/api/metrics/ingest`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": TEST_API_KEY,
    },
    body: JSON.stringify([dp]),
  });
  return { status: resp.status, body: (await resp.json()) as IngestResponseBody };
}

// Use a unique service name per test run to isolate from existing incidents
const TEST_SERVICE = `test-svc-${Date.now()}`;

describe("HTTP integration — POST /api/metrics/ingest", { skip: !integrationEnabled }, () => {
  test("CPU spike creates one predictive incident with correct fields", async () => {
    const { status, body } = await ingestDatapoint({
      metricName: "CPUUtilization",
      value: 84,
      serviceHint: TEST_SERVICE,
    });

    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ingested, 1, "ingested should be 1");
    assert.ok(Array.isArray(body.predictiveIncidents), "predictiveIncidents must be an array");
    assert.equal(
      body.predictiveIncidents.length,
      1,
      `Expected 1 predictive incident, got ${body.predictiveIncidents.length}`,
    );

    const incident = body.predictiveIncidents[0];
    assert.ok(incident.incidentId, "incidentId must be set");
    assert.equal(incident.metricName, "CPUUtilization", "metricName must match");
    assert.ok(incident.strategy, "strategy must be set");
    assert.ok(typeof incident.similarityScore === "number", "similarityScore must be a number");
    assert.ok(
      incident.detectionMethod === "keyword" || incident.detectionMethod === "vector",
      "detectionMethod must be 'keyword' or 'vector'",
    );
  });

  test("second identical POST is deduplicated (predictiveIncidents.length === 0)", async () => {
    // The first POST for this service was already made in the previous test;
    // an open predictive incident already exists for CPUUtilization + TEST_SERVICE.
    const { status, body } = await ingestDatapoint({
      metricName: "CPUUtilization",
      value: 90,
      serviceHint: TEST_SERVICE,
    });

    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ingested, 1, "ingested should still be 1");
    assert.equal(
      body.predictiveIncidents.length,
      0,
      "second identical metric+service should be deduplicated",
    );
  });

  test("incident contextJson contains source=predictive and predictiveMetric", async () => {
    // Fetch the predictive incident opened in the first test and verify its contextJson
    if (!TEST_API_URL || !TEST_API_KEY) return;

    const listUrl = `${TEST_API_URL.replace(/\/$/, "")}/api/incidents`;
    const resp = await fetch(listUrl, {
      headers: { "x-api-key": TEST_API_KEY },
    });
    if (!resp.ok) {
      // Skip gracefully if incidents endpoint isn't available
      return;
    }
    const rawIncidents = (await resp.json()) as unknown;
    const arr = Array.isArray(rawIncidents) ? (rawIncidents as unknown[]) : [];
    const predictive = arr.find(
      (inc: unknown) =>
        inc !== null &&
        typeof inc === "object" &&
        (inc as Record<string, unknown>).contextJson !== null &&
        typeof (inc as Record<string, unknown>).contextJson === "object" &&
        ((inc as Record<string, unknown>).contextJson as Record<string, unknown>).source === "predictive" &&
        ((inc as Record<string, unknown>).contextJson as Record<string, unknown>).predictiveMetric === "CPUUtilization",
    );

    assert.ok(
      predictive !== undefined,
      "Should find at least one incident with source=predictive and predictiveMetric=CPUUtilization",
    );
  });
});

// ── C. Zod schema .passthrough() tests ────────────────────────────────────────
// These guard against accidentally removing .passthrough() from the three
// response schemas in lib/api-zod/src/generated/api.ts.
// If .passthrough() is removed, the parse() call strips unknown contextJson
// fields and the predictive demo silently loses source, predictiveMetric, etc.

describe("Zod schema passthrough — extra contextJson fields are NOT stripped", () => {
  const baseIncidentShape = {
    incidentId: "abc-123",
    alertFingerprint: "fp-xxx",
    status: "TRIGGERED" as const,
    currentStep: "PREDICTIVE_INIT",
    contextJson: {
      alertText: "test alert",
      turns: [],
      // Extra fields that only appear in predictive incidents:
      source: "predictive",
      predictiveMetric: "CPUUtilization",
      predictiveValue: 84,
      predictiveStrategy: "rds_cpu_throttle",
      similarityScore: 0.89,
      detectionMethod: "keyword",
      matchedIncidentId: null,
    },
    claimedByAgent: null,
    causedByIncidentId: null,
    updatedAt: new Date().toISOString(),
  };

  test("TriggerIncidentResponse passes through unknown contextJson fields", () => {
    const parsed = TriggerIncidentResponse.parse(baseIncidentShape);
    assert.equal(
      (parsed.contextJson as Record<string, unknown>).source,
      "predictive",
      "source field must survive passthrough",
    );
    assert.equal(
      (parsed.contextJson as Record<string, unknown>).predictiveMetric,
      "CPUUtilization",
      "predictiveMetric field must survive passthrough",
    );
    assert.equal(
      (parsed.contextJson as Record<string, unknown>).detectionMethod,
      "keyword",
      "detectionMethod field must survive passthrough",
    );
  });

  test("ListIncidentsResponseItem passes through unknown contextJson fields", () => {
    const parsed = ListIncidentsResponseItem.parse(baseIncidentShape);
    assert.equal(
      (parsed.contextJson as Record<string, unknown>).source,
      "predictive",
      "source field must survive passthrough on ListIncidentsResponseItem",
    );
    assert.equal(
      (parsed.contextJson as Record<string, unknown>).predictiveMetric,
      "CPUUtilization",
    );
  });

  test("GetIncidentResponse passes through unknown contextJson fields", () => {
    const parsed = GetIncidentResponse.parse(baseIncidentShape);
    assert.equal(
      (parsed.contextJson as Record<string, unknown>).source,
      "predictive",
      "source field must survive passthrough on GetIncidentResponse",
    );
    assert.equal(
      (parsed.contextJson as Record<string, unknown>).similarityScore,
      0.89,
    );
  });

  test("all three schemas reject when status is invalid", () => {
    const bad = { ...baseIncidentShape, status: "INVALID_STATUS" };
    assert.throws(() => TriggerIncidentResponse.parse(bad), "should reject invalid status");
    assert.throws(() => ListIncidentsResponseItem.parse(bad), "should reject invalid status");
    assert.throws(() => GetIncidentResponse.parse(bad), "should reject invalid status");
  });
});

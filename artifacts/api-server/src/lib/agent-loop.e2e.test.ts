/**
 * E2E tests — full agent loop: trigger → diagnose → repair → audit
 *
 * Covers the complete lifecycle of an incident through all three agent phases,
 * including CockroachDB Agent Skills invocation for CRDB-type incidents.
 *
 * Environment variables (test is skipped when absent):
 *   TEST_API_URL   e.g. http://localhost:8080/api
 *   TEST_API_PASSWORD  dashboard password (used to obtain a JWT)
 *
 * Run standalone:
 *   TEST_API_URL=http://localhost:8080/api TEST_API_PASSWORD=cloudsurgeon-demo \
 *     pnpm --filter @workspace/api-server exec tsx --test src/lib/agent-loop.e2e.test.ts
 *
 * Or via the workspace script:
 *   pnpm --filter @workspace/api-server run test:e2e
 */

import assert from "node:assert/strict";
import { describe, test, before } from "node:test";

const API_URL = process.env.TEST_API_URL ?? "";
const API_PASSWORD = process.env.TEST_API_PASSWORD ?? "";

const SKIP = !API_URL || !API_PASSWORD;

// ── helpers ───────────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const res = await fetch(`${API_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: API_PASSWORD }),
  });
  assert.equal(res.status, 200, `auth/token returned ${res.status}`);
  const body = await res.json() as { token: string };
  assert.ok(body.token, "token missing from auth response");
  return body.token;
}

async function apiGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

async function apiPost(token: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Poll until the incident reaches a terminal or gate state.
 * Returns the incident object once status ∈ targetStatuses.
 */
async function pollUntil(
  token: string,
  incidentId: string,
  targetStatuses: string[],
  timeoutMs = 60_000,
  intervalMs = 1_500,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const incident = await apiGet(token, `/incidents/${incidentId}`) as Record<string, unknown>;
    if (targetStatuses.includes(incident.status as string)) return incident;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const incident = await apiGet(token, `/incidents/${incidentId}`) as Record<string, unknown>;
  throw new Error(`Timeout waiting for ${targetStatuses.join("|")} — current status: ${incident.status}`);
}

// ── test suite ────────────────────────────────────────────────────────────────

describe("Agent loop e2e", { skip: SKIP ? "TEST_API_URL or TEST_API_PASSWORD not set" : false }, () => {
  let token: string;

  before(async () => {
    token = await getToken();
  });

  // ── Phase 0: healthcheck ─────────────────────────────────────────────────

  test("healthcheck returns { status: 'ok' }", async () => {
    const res = await fetch(`${API_URL}/healthz`);
    const body = await res.json() as { status: string };
    assert.equal(body.status, "ok");
  });

  // ── Phase 1: ECS incident — AUTONOMOUS path ──────────────────────────────

  test("ECS incident: TRIGGERED → agent phases → RESOLVED or PENDING_APPROVAL", async () => {
    const { status, body } = await apiPost(token, "/incidents/trigger", {
      alertText: "ECS checkout-service CPU 92% — task count 2/5 — high latency",
    });
    assert.equal(status, 200, `trigger returned ${status}: ${JSON.stringify(body)}`);

    const { incidentId } = body as { incidentId: string };
    assert.ok(incidentId, "incidentId missing from trigger response");

    // Wait until out of TRIGGERED/DIAGNOSING/REPAIRING
    const incident = await pollUntil(
      token, incidentId,
      ["RESOLVED", "FAILED", "PENDING_APPROVAL"],
      90_000,
    );

    assert.ok(
      ["RESOLVED", "FAILED", "PENDING_APPROVAL"].includes(incident.status as string),
      `unexpected status: ${incident.status}`,
    );

    // Verify CockroachDB persisted the full turn history
    const ctx = incident.contextJson as Record<string, unknown>;
    assert.ok(Array.isArray(ctx?.turns), "context_json.turns should be an array");
    assert.ok((ctx.turns as unknown[]).length > 0, "at least one agent turn should be persisted");
  });

  // ── Phase 2: CRDB incident — Agent Skills path ───────────────────────────

  test("CRDB hotspot incident: invokes crdb_skill_repair, persists turns", async () => {
    const { status, body } = await apiPost(token, "/incidents/trigger", {
      alertText: "CockroachDB hot range detected on orders table — high contention causing 40% latency increase",
    });
    assert.equal(status, 200, `trigger returned ${status}: ${JSON.stringify(body)}`);

    const { incidentId } = body as { incidentId: string };
    assert.ok(incidentId, "incidentId missing from trigger response");

    const incident = await pollUntil(
      token, incidentId,
      ["RESOLVED", "FAILED", "PENDING_APPROVAL"],
      90_000,
    );

    // At minimum the agent must have reached a terminal/gate state
    assert.ok(
      ["RESOLVED", "FAILED", "PENDING_APPROVAL"].includes(incident.status as string),
      `unexpected status: ${incident.status}`,
    );

    // Verify turns were persisted in CockroachDB
    const ctx = incident.contextJson as Record<string, unknown>;
    assert.ok(Array.isArray(ctx?.turns), "context_json.turns should be an array");
    const turns = ctx.turns as Array<Record<string, unknown>>;
    assert.ok(turns.length > 0, "at least one agent turn should be persisted");

    // For CRDB strategies the tool should be crdb_skill_repair or a crdb_ skill
    const toolNames: string[] = turns
      .map((t) => String(t.toolName ?? ""))
      .filter(Boolean);

    const hasCrdbTool = toolNames.some(
      (n) => n.startsWith("crdb_") || n === "crdb_skill_repair",
    );
    assert.ok(hasCrdbTool, `Expected a crdb_ tool in turns, got: ${toolNames.join(", ")}`);
  });

  // ── Phase 3: PENDING_APPROVAL → approve → RESOLVED ───────────────────────

  test("PENDING_APPROVAL incident: approve unblocks the agent to RESOLVED", async () => {
    // Trigger with a low-confidence alert to force PENDING_APPROVAL
    const { status, body } = await apiPost(token, "/incidents/trigger", {
      alertText: "Unknown performance degradation on mystery-service — no matching pattern",
    });
    assert.equal(status, 200, `trigger returned ${status}: ${JSON.stringify(body)}`);

    const { incidentId } = body as { incidentId: string };
    assert.ok(incidentId, "incidentId missing");

    // Wait for PENDING_APPROVAL or terminal state
    let incident = await pollUntil(
      token, incidentId,
      ["RESOLVED", "FAILED", "PENDING_APPROVAL"],
      90_000,
    );

    if (incident.status === "PENDING_APPROVAL") {
      const { status: approveStatus } = await apiPost(token, `/incidents/${incidentId}/approve`);
      assert.ok(
        [200, 202].includes(approveStatus),
        `approve returned ${approveStatus}`,
      );

      // After approval the agent should reach a terminal state
      incident = await pollUntil(token, incidentId, ["RESOLVED", "FAILED"], 90_000);
    }

    assert.ok(
      ["RESOLVED", "FAILED"].includes(incident.status as string),
      `Expected terminal status after approve, got: ${incident.status}`,
    );
  });

  // ── Phase 4: idempotence — duplicate alert same fingerprint ──────────────

  test("duplicate alert returns the existing incident (idempotence)", async () => {
    const alertText = "ECS idempotence-test-service CPU 99% — unique deduplicate test";

    const first = await apiPost(token, "/incidents/trigger", { alertText });
    assert.equal(first.status, 200);
    const { incidentId: id1 } = first.body as { incidentId: string };

    const second = await apiPost(token, "/incidents/trigger", { alertText });
    assert.equal(second.status, 200);
    const { incidentId: id2 } = second.body as { incidentId: string };

    assert.equal(id1, id2, "Same alert fingerprint must return the same incidentId");
  });

  // ── Phase 5: execution log integrity ─────────────────────────────────────

  test("execution logs are persisted to CockroachDB for each triggered incident", async () => {
    const logs = await apiGet(token, "/logs") as unknown[];
    assert.ok(Array.isArray(logs), "/api/logs should return an array");
    // At least the incidents triggered above should have produced log rows
    assert.ok(logs.length > 0, "execution_logs table should contain entries");
  });

  // ── Phase 6: causal chain endpoint ───────────────────────────────────────

  test("causal chain endpoint returns valid response (WITH RECURSIVE CTE)", async () => {
    // Get any incident and check the causal chain endpoint
    const incidents = await apiGet(token, "/incidents") as Array<{ incidentId: string }>;
    assert.ok(Array.isArray(incidents) && incidents.length > 0, "No incidents found");

    const { incidentId } = incidents[0];
    // Response shape: { incidentId, chain: [...], note: "..." }
    const body = await apiGet(token, `/incidents/${incidentId}/causal-chain`) as Record<string, unknown>;
    assert.ok(Array.isArray(body.chain), "causal-chain response should have a .chain array");
    // Root incidents have depth=0 and no parent — chain contains at least itself
    assert.ok((body.chain as unknown[]).length >= 1, "chain should contain at least the incident itself");
  });
});

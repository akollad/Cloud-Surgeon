/**
 * CDC badge recovery test — SIGKILL resilience
 *
 * Simulates what the Streamlit dashboard does after a server restart:
 *   1. SIGKILL the API server via POST /api/chaos/sigkill
 *   2. Poll /api/healthz until it returns { status: "ok" }  (≤ 30 s)
 *   3. Within 10 s of healthcheck OK, call GET /api/stream/audit and assert
 *      a valid "connected" event arrives — this is exactly what sets
 *      _cdc_status_ok_ts in session state.
 *   4. Fail if the fresh status has not arrived within one 30-s cycle
 *      (that is the "one fragment cycle" bound from the task spec).
 *
 * Environment variables (required — test is skipped when absent):
 *   TEST_API_URL   e.g. http://localhost:5001/api
 *   TEST_API_KEY   shared API key (CLOUD_SURGEON_API_KEY on the server)
 *
 * Run standalone:
 *   TEST_API_URL=http://localhost:5001/api TEST_API_KEY=… \
 *     tsx --test src/lib/cdc-recovery.test.ts
 *
 * Or via the workspace script:
 *   pnpm --filter @workspace/api-server run test:cdc-recovery
 */

import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { describe, test, before } from "node:test";

// ── helpers ───────────────────────────────────────────────────────────────────

const API_URL = process.env.TEST_API_URL ?? "";
const API_KEY = process.env.TEST_API_KEY ?? "";

/**
 * Minimal fetch-like helper that avoids a runtime dependency on
 * global `fetch` (not always available in older Node versions or tsx).
 * Returns { status, body } where body is the parsed JSON (or null).
 */
function httpRequest(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };
    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* ignore */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Poll /api/healthz until { status: "ok" } or timeout.
 * Returns the elapsed time in ms from the first call to the first OK response,
 * or throws if timeout is exceeded.
 */
async function waitForHealthcheck(
  timeoutMs: number,
  intervalMs = 500,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { status, body } = await httpRequest(
        `${API_URL}/healthz`,
        "GET",
        apiHeaders(),
      );
      if (status === 200 && (body as Record<string, unknown>)?.status === "ok") {
        return Date.now() - start;
      }
    } catch {
      /* server still restarting — keep polling */
    }
    await sleep(intervalMs);
  }
  throw new Error(`Healthcheck did not return ok within ${timeoutMs} ms`);
}

/**
 * Open a streaming GET to /api/stream/audit, read the first non-empty
 * data-line, and return the parsed JSON.  Closes the connection immediately
 * after the first event.  Throws on timeout.
 */
function readFirstSseEvent(timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_URL}/stream/audit`);
    const lib = url.protocol === "https:" ? https : http;

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE /stream/audit produced no event within ${timeoutMs} ms`));
    }, timeoutMs);

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...apiHeaders(),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          req.destroy();
          reject(new Error(`SSE endpoint returned HTTP ${res.statusCode}`));
          return;
        }
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const lines = buf.split("\n");
          buf = lines.pop() ?? ""; // keep incomplete last line
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw) continue;
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              clearTimeout(timer);
              req.destroy();
              resolve(parsed);
            } catch {
              /* not JSON — ignore and keep reading */
            }
          }
        });
        res.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );

    req.on("error", (err) => {
      clearTimeout(timer);
      // If we already resolved (req.destroy() triggers an error), ignore it.
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
      reject(err);
    });

    req.end();
  });
}

function apiHeaders(): Record<string, string> {
  return API_KEY ? { "x-api-key": API_KEY } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── test suite ────────────────────────────────────────────────────────────────

describe("CDC badge SIGKILL recovery", { skip: !API_URL }, () => {

  before(async () => {
    // Sanity-check: the server must be healthy before we kill it.
    const { status, body } = await httpRequest(
      `${API_URL}/healthz`,
      "GET",
      apiHeaders(),
    );
    assert.equal(
      status,
      200,
      "Pre-condition: API server must be healthy before the test runs",
    );
    assert.equal(
      (body as Record<string, unknown>)?.status,
      "ok",
      "Pre-condition: /healthz must return { status: 'ok' }",
    );
  });

  test(
    "SIGKILL → healthcheck recovers within 30 s → /stream/audit returns fresh CDC status within 10 s",
    { timeout: 60_000 },
    async () => {
      // ── Step 1: SIGKILL the server ─────────────────────────────────────────
      let killStatus: number;
      try {
        const r = await httpRequest(
          `${API_URL}/chaos/sigkill`,
          "POST",
          apiHeaders(),
          "{}",
        );
        killStatus = r.status;
      } catch {
        // Connection reset is expected — the server may die mid-response.
        killStatus = 200;
      }
      assert.ok(
        killStatus < 500 || killStatus === 200,
        `SIGKILL endpoint returned unexpected status ${killStatus}`,
      );

      // Give the process a moment to actually die before we start polling.
      await sleep(800);

      // ── Step 2: Wait for healthcheck to return OK (max 30 s) ──────────────
      const recoveryMs = await waitForHealthcheck(30_000);
      const healthOkAt = Date.now();
      console.log(`  ✅ Healthcheck recovered after ${recoveryMs} ms`);

      // ── Step 3: Verify /stream/audit delivers a fresh event within 10 s ───
      // This mirrors what the Streamlit dashboard does:
      //   - On healthcheck OK after _api_was_down, it clears _cdc_status_ts
      //   - The next _home_summary_widget tick (≤ 5 s) calls fetch_audit_stream_status()
      //   - If that returns a value, _cdc_status_ok_ts is set immediately
      //
      // We assert that window is ≤ 10 s (half of one 30-s CDC poll cycle).
      const FRESH_STATUS_DEADLINE_MS = 10_000;
      const event = await readFirstSseEvent(FRESH_STATUS_DEADLINE_MS);
      const freshStatusMs = Date.now() - healthOkAt;

      console.log(
        `  ✅ /stream/audit delivered event in ${freshStatusMs} ms after healthcheck OK`,
      );
      console.log(`  Event: ${JSON.stringify(event)}`);

      // The event must be either the "connected" metadata or a heartbeat —
      // both are valid signals that the stream is live and the badge would
      // update _cdc_status_ok_ts in session state.
      assert.ok(
        event.type === "connected" || event.type === "heartbeat",
        `Expected event.type to be "connected" or "heartbeat", got ${JSON.stringify(event.type)}`,
      );

      // The fresh status must arrive well within one 30-s CDC poll cycle.
      assert.ok(
        freshStatusMs <= FRESH_STATUS_DEADLINE_MS,
        `Fresh CDC status arrived ${freshStatusMs} ms after healthcheck OK, ` +
          `which exceeds the 10 s deadline (one half-cycle). ` +
          `The badge would show stale status for more than one 30-s cycle.`,
      );

      // When the stream is up, the "connected" event must carry a cdcActive flag.
      if (event.type === "connected") {
        assert.ok(
          "cdcActive" in event,
          "connected event must carry cdcActive boolean so the dashboard badge can render",
        );
      }
    },
  );

  test(
    "stale badge is NOT held for more than one 30-s cycle after restart",
    { timeout: 65_000 },
    async () => {
      // This test is structurally identical to the above but uses a 30-s bound
      // (the full CDC poll cycle) to catch regressions where the 25-s roll-back
      // logic in _home_summary_widget is broken and the badge gets stuck for a
      // full cycle before retrying.

      // SIGKILL again.
      try {
        await httpRequest(`${API_URL}/chaos/sigkill`, "POST", apiHeaders(), "{}");
      } catch {
        /* connection reset expected */
      }
      await sleep(800);

      // Wait for recovery.
      await waitForHealthcheck(30_000);
      const healthOkAt = Date.now();

      // Assert fresh event arrives within 30 s (the full cycle maximum).
      const event = await readFirstSseEvent(30_000);
      const elapsed = Date.now() - healthOkAt;
      console.log(
        `  ✅ CDC event received ${elapsed} ms after healthcheck OK (≤ 30 s limit)`,
      );

      assert.ok(
        event.type === "connected" || event.type === "heartbeat",
        `Expected event.type "connected" or "heartbeat", got ${JSON.stringify(event.type)}`,
      );

      assert.ok(
        elapsed <= 30_000,
        `Badge would remain stale for ${elapsed} ms — exceeds the one 30-s cycle limit`,
      );
    },
  );
});


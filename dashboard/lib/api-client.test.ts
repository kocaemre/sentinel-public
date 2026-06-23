import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Unit proof for the dashboard's HTTP read client (DIST-02, D-03).
 *
 * Strategy: stub the global `fetch` so no network/proxy is needed, then assert the
 * `api-client` contract:
 *   - `protectedAtomic` round-trips as the EXACT atomic-unit STRING (a value past 2^53),
 *     never `Number()`-coerced (Pitfall 4 / threat T-05-09 — money survives the HTTP boundary).
 *   - every fetch is issued with `{ cache: "no-store" }` (threat T-05-05 — live data, no cache).
 *   - a non-OK response throws a clear Error (callers surface the error state).
 *   - `getFeed` unwraps `{ feed }`, `getVerdict` unwraps `{ verdict }` (404 → undefined),
 *     `getAttacksByType` reads the `/api/metrics` `byType` field — matching the Plan-01 shapes.
 *
 * Runner: node:test (NOT vitest) — matches the repo (proxy/test/* + the old db.test.ts).
 * `SENTINEL_API_BASE_URL` is set so `api-client` reads the PLAIN server var (NOT NEXT_PUBLIC_).
 */

const BASE = "http://proxy.test";
// A value past Number.MAX_SAFE_INTEGER (2^53-1 = 9007199254740991) — float-coercing it loses precision.
const HUGE_ATOMIC = "12345678901234567890";

type FetchCall = { url: string; init: RequestInit | undefined };
let calls: FetchCall[];
let originalFetch: typeof globalThis.fetch;
let originalBase: string | undefined;

/** Build a stub `fetch` returning a fixed status + JSON body, recording each call. */
function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  originalBase = process.env.SENTINEL_API_BASE_URL;
  process.env.SENTINEL_API_BASE_URL = BASE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.SENTINEL_API_BASE_URL;
  else process.env.SENTINEL_API_BASE_URL = originalBase;
});

test("getMetrics returns protectedAtomic as the EXACT string past 2^53 (never float-coerced)", async () => {
  stubFetch(200, {
    screened: 3,
    blocked: 2,
    protectedAtomic: HUGE_ATOMIC,
    byType: [{ matched_attack: "prompt_injection_payment", count: 1 }],
    distinctAgents: 2,
  });
  const { getMetrics } = await import("./api-client");
  const m = await getMetrics();

  assert.equal(m.protectedAtomic, HUGE_ATOMIC, "atomic string is byte-identical");
  assert.equal(typeof m.protectedAtomic, "string", "money stays a string");
  // Round-tripping through Number would have rounded it; prove it did not.
  assert.notEqual(Number(m.protectedAtomic).toString(), m.protectedAtomic);
  assert.equal(m.screened, 3);
  assert.equal(m.blocked, 2);
  assert.equal(m.distinctAgents, 2);
});

test("every fetch is issued with cache: no-store and hits the proxy base URL", async () => {
  stubFetch(200, { screened: 0, blocked: 0, protectedAtomic: "0", byType: [], distinctAgents: 0 });
  const { getMetrics } = await import("./api-client");
  await getMetrics();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/api/metrics`);
  assert.equal(calls[0].init?.cache, "no-store");
});

test("a non-OK response throws a clear Error rather than returning bad data", async () => {
  stubFetch(503, { error: "audit store not ready" });
  const { getMetrics } = await import("./api-client");
  await assert.rejects(() => getMetrics(), /sentinel read \/api\/metrics -> 503/);
});

test("getFeed requests /api/feed?limit=N, unwraps { feed }, no-store", async () => {
  const feed = [
    { id: 2, decided_at: 2000, decision: "block", matched_attack: "overpayment_drain", amount_atomic: HUGE_ATOMIC },
    { id: 1, decided_at: 1000, decision: "allow", matched_attack: null, amount_atomic: "1000" },
  ];
  stubFetch(200, { feed });
  const { getFeed } = await import("./api-client");
  const rows = await getFeed(25);

  assert.equal(calls[0].url, `${BASE}/api/feed?limit=25`);
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 2);
  // Per-row atomic money also survives as an exact string.
  assert.equal(rows[0].amount_atomic, HUGE_ATOMIC);
  assert.equal(typeof rows[0].amount_atomic, "string");
});

test("getFeed throws on a non-OK feed response", async () => {
  stubFetch(500, { error: "boom" });
  const { getFeed } = await import("./api-client");
  await assert.rejects(() => getFeed(10), /sentinel read \/api\/feed\?limit=10 -> 500/);
});

test("getVerdict unwraps { verdict } on 200 and returns undefined on 404", async () => {
  stubFetch(200, {
    verdict: { id: 7, decision: "block", protected_atomic: HUGE_ATOMIC, reasons: '["x"]' },
  });
  const { getVerdict } = await import("./api-client");
  const v = await getVerdict(7);
  assert.equal(calls[0].url, `${BASE}/api/verdict/7`);
  assert.equal(calls[0].init?.cache, "no-store");
  assert.ok(v);
  assert.equal(v!.id, 7);
  assert.equal(v!.protected_atomic, HUGE_ATOMIC);

  // A missing id is `undefined`, not an error (mirrors the Phase 4 contract).
  calls = [];
  stubFetch(404, { error: "verdict not found" });
  const { getVerdict: getVerdict2 } = await import("./api-client");
  const missing = await getVerdict2(99999);
  assert.equal(missing, undefined);
});

test("getVerdict throws on a non-OK, non-404 response", async () => {
  stubFetch(503, { error: "audit store not ready" });
  const { getVerdict } = await import("./api-client");
  await assert.rejects(() => getVerdict(3), /sentinel read \/api\/verdict\/3 -> 503/);
});

test("getAttacksByType reads /api/metrics and returns the byType buckets", async () => {
  stubFetch(200, {
    screened: 5,
    blocked: 3,
    protectedAtomic: "0",
    distinctAgents: 1,
    byType: [
      { matched_attack: "prompt_injection_payment", count: 2 },
      { matched_attack: "overpayment_drain", count: 1 },
    ],
  });
  const { getAttacksByType } = await import("./api-client");
  const buckets = await getAttacksByType();
  assert.equal(calls[0].url, `${BASE}/api/metrics`);
  assert.equal(calls[0].init?.cache, "no-store");
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].matched_attack, "prompt_injection_payment");
  assert.equal(buckets[0].count, 2);
});

test("the base URL is read from SENTINEL_API_BASE_URL (a PLAIN server var, not NEXT_PUBLIC_)", async () => {
  delete process.env.SENTINEL_API_BASE_URL;
  stubFetch(200, {});
  const { getMetrics } = await import("./api-client");
  await assert.rejects(() => getMetrics(), /SENTINEL_API_BASE_URL is not set/);
});

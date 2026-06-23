import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

/**
 * Delegation proof for the dashboard's server-only read boundary `db.ts` (DIST-02, D-03).
 *
 * Phase 5 re-pointed the reads from a shared SQLite file to HTTP-over-tunnel. So this test
 * no longer seeds/opens a SQLite file (the Phase 4 strategy) and imports no native SQLite
 * addon and references no shared-db-path env var. Instead it proves db.ts DELEGATES to `./api-client`:
 * it stubs `server-only` to a no-op (the real package throws outside an RSC bundle — that
 * boundary is enforced by Next at build time) and stubs the global `fetch` so db.ts's four
 * exported fns reach the real api-client, which reads `SENTINEL_API_BASE_URL` and fetches
 * the proxy's JSON. We assert each db.ts fn returns the proxy payload (delegation works) and
 * that money survives as an atomic STRING. The atomic-string fidelity is also proven
 * directly in `api-client.test.ts`.
 *
 * Runner: node:test (NOT vitest) — matches the repo (proxy/test/* + api-client.test.ts).
 */

// tsx loads modules through CJS, so neutralize the `server-only` throw by pre-seeding the
// CJS require cache with a no-op stub BEFORE db.ts (which `require`s it) is imported.
const req = createRequire(import.meta.url);
const serverOnlyPath = req.resolve("server-only");
// Module._cache is an internal but stable CJS map.
(Module as unknown as { _cache: Record<string, unknown> })._cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
};

const BASE = "http://proxy.test";
const HUGE_ATOMIC = "12345678901234567890";

const METRICS_BODY = {
  screened: 9,
  blocked: 4,
  protectedAtomic: HUGE_ATOMIC,
  byType: [{ matched_attack: "prompt_injection_payment", count: 4 }],
  distinctAgents: 3,
};
const FEED_BODY = { feed: [{ id: 2, amount_atomic: HUGE_ATOMIC }, { id: 1 }] };
const VERDICT_BODY = { verdict: { id: 7, decision: "block", protected_atomic: HUGE_ATOMIC } };

type FetchCall = { url: string; init: RequestInit | undefined };
let calls: FetchCall[];
let originalFetch: typeof globalThis.fetch;
let originalBase: string | undefined;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  originalBase = process.env.SENTINEL_API_BASE_URL;
  process.env.SENTINEL_API_BASE_URL = BASE;

  // Route db.ts -> api-client -> fetch to a stub keyed on the requested path.
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    let body: unknown = {};
    if (url.endsWith("/api/metrics")) body = METRICS_BODY;
    else if (url.includes("/api/feed")) body = FEED_BODY;
    else if (url.includes("/api/verdict/")) body = VERDICT_BODY;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.SENTINEL_API_BASE_URL;
  else process.env.SENTINEL_API_BASE_URL = originalBase;
});

test("db.ts loads without opening SQLite (server-only stubbed, no native addon)", async () => {
  // If db.ts still opened a local database this import would do native work; it loads as a
  // thin delegating module (HTTP-over-tunnel) instead.
  const mod = await import("./db");
  assert.equal(typeof mod.getMetrics, "function");
  assert.equal(typeof mod.getFeed, "function");
  assert.equal(typeof mod.getVerdict, "function");
  assert.equal(typeof mod.getAttacksByType, "function");
});

test("getMetrics delegates to api-client (no-store fetch to the proxy) and returns its payload", async () => {
  const { getMetrics } = await import("./db");
  const m = await getMetrics();
  assert.equal(calls.at(-1)!.url, `${BASE}/api/metrics`);
  assert.equal(calls.at(-1)!.init?.cache, "no-store");
  assert.equal(m.protectedAtomic, HUGE_ATOMIC);
  assert.equal(typeof m.protectedAtomic, "string");
  assert.equal(m.distinctAgents, 3);
});

test("getFeed forwards the limit through api-client", async () => {
  const { getFeed } = await import("./db");
  const feed = await getFeed(25);
  assert.equal(calls.at(-1)!.url, `${BASE}/api/feed?limit=25`);
  assert.equal(feed.length, 2);
  assert.equal(feed[0].amount_atomic, HUGE_ATOMIC);
});

test("getVerdict forwards the id through api-client", async () => {
  const { getVerdict } = await import("./db");
  const v = await getVerdict(7);
  assert.equal(calls.at(-1)!.url, `${BASE}/api/verdict/7`);
  assert.ok(v);
  assert.equal(v!.id, 7);
  assert.equal(v!.protected_atomic, HUGE_ATOMIC);
});

test("getAttacksByType delegates to api-client (reads /api/metrics byType)", async () => {
  const { getAttacksByType } = await import("./db");
  const buckets = await getAttacksByType();
  assert.equal(calls.at(-1)!.url, `${BASE}/api/metrics`);
  assert.equal(buckets[0].matched_attack, "prompt_injection_payment");
  assert.equal(buckets[0].count, 4);
});

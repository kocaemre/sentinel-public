import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { getCommitStores } from "../src/decision/stub.js";
import type { Config } from "../src/config.js";
import { makeTestConfig } from "./helpers/config.js";
import type { AuditRow } from "../src/policy/audit.js";

/**
 * Phase-5 Plan 01 Task 2 e2e proof: the three JSON read endpoints (DIST-02, D-03)
 * mirror dashboard/lib/queries.ts 1:1, money stays an atomic STRING over the wire
 * (T-05-09 / Pitfall 4), every response is `Cache-Control: no-store`, the feed limit
 * clamps to 1..200, and verdict returns 404 (absent) / 400 (malformed).
 *
 * The server holds the audit store as a module singleton (getCommitStores().audit,
 * opened by configureDecision from the test config's dbPath). We seed it directly,
 * then fetch the live endpoints — proving they serve exactly what the store holds.
 */

let proxy: FastifyInstance;
let proxyPort: number;

// A protected amount well past 2^53 — proves the SUM survives the HTTP boundary as an
// exact STRING (a JS-number coercion would lose precision / go NaN).
const BIG_PROTECTED = "12345678901234567890";
// Two such blocks summed in BigInt — the exact decimal STRING the metrics endpoint emits.
const SUM_OF_TWO = (BigInt(BIG_PROTECTED) * 2n).toString();

const blockRow = (over: Partial<AuditRow> = {}): AuditRow => ({
  decided_at: 1_000_000_000_000,
  decision: "block",
  control: "per_call_cap",
  matched_attack: "prompt_injection_payment",
  injection_detected: 1,
  reasons: JSON.stringify(["injection in description"]),
  amount_atomic: BIG_PROTECTED,
  protected_atomic: BIG_PROTECTED,
  target_host: "evil.example.com",
  resource: "/paid-overpriced",
  settlement_tx: null,
  source: "203.0.113.7",
  agent_label: "attacker-bot",
  ...over,
});

before(async () => {
  // A dedicated :memory: db for this server instance; getCommitStores() exposes the
  // SAME live handle, so seeding it is visible to the read endpoints.
  const config: Config = makeTestConfig({ dbPath: ":memory:" });
  proxy = buildServer(config);
  await proxy.listen({ port: 0, host: "127.0.0.1" });
  proxyPort = (proxy.server.address() as AddressInfo).port;

  const stores = getCommitStores();
  assert.ok(stores, "configureDecision opened the commit stores (incl. audit)");
  // Seed two blocks (big protected sum, distinct sources) + a clean allow.
  stores!.audit.insert(blockRow({ source: "203.0.113.7" }));
  stores!.audit.insert(blockRow({ source: "203.0.113.8", protected_atomic: BIG_PROTECTED }));
  stores!.audit.insert(
    blockRow({
      decision: "allow",
      control: null,
      matched_attack: "none",
      injection_detected: 0,
      protected_atomic: null,
      settlement_tx: "0xfeed",
      source: "203.0.113.9",
    }),
  );
});

after(async () => {
  await proxy?.close();
});

const base = () => `http://127.0.0.1:${proxyPort}`;

test("GET /api/metrics: shape + atomic-string protectedAtomic + byType + distinctAgents + no-store", async () => {
  const res = await fetch(`${base()}/api/metrics`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store", "metrics is no-store");
  // Read the RAW text and assert the money field is a JSON STRING (quoted), not a number.
  const text = await res.text();
  assert.match(
    text,
    new RegExp(`"protectedAtomic"\\s*:\\s*"${SUM_OF_TWO}"`),
    "protectedAtomic is a quoted STRING (never a JSON number)",
  );
  const body = JSON.parse(text) as {
    screened: number;
    blocked: number;
    protectedAtomic: string;
    byType: Array<{ matched_attack: string; count: number }>;
    distinctAgents: number;
  };
  assert.equal(typeof body.protectedAtomic, "string", "protectedAtomic stays a string after parse");
  // 2 blocks × BIG_PROTECTED summed in BigInt.
  assert.equal(body.protectedAtomic, SUM_OF_TWO, "exact BigInt sum");
  assert.equal(body.screened, 3, "screened = COUNT(*)");
  assert.equal(body.blocked, 2, "blocked = non-allow rows");
  assert.ok(Array.isArray(body.byType), "byType is an array");
  assert.equal(body.byType[0].matched_attack, "prompt_injection_payment");
  assert.equal(body.byType[0].count, 2);
  // 3 distinct sources, no dev excluded (test config devSource is "").
  assert.equal(body.distinctAgents, 3, "all 3 distinct sources counted (no dev exclusion)");
});

test("GET /api/feed: returns { feed } and clamps limit to 1..200, no-store", async () => {
  const res = await fetch(`${base()}/api/feed?limit=2`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { feed: Array<{ id: number; source: string | null }> };
  assert.ok(Array.isArray(body.feed));
  assert.equal(body.feed.length, 2, "limit=2 honored");

  // Over-max clamps to 200 (we only have 3 rows, so all 3 come back).
  const big = await fetch(`${base()}/api/feed?limit=99999`);
  const bigBody = (await big.json()) as { feed: unknown[] };
  assert.equal(bigBody.feed.length, 3, "over-max limit clamped (all rows, <=200)");

  // limit=0 / negative clamps up to 1.
  const zero = await fetch(`${base()}/api/feed?limit=0`);
  const zeroBody = (await zero.json()) as { feed: unknown[] };
  assert.equal(zeroBody.feed.length, 1, "limit<1 clamps to 1");
});

test("GET /api/verdict/:id: present → { verdict }, absent → 404, malformed → 400, all no-store", async () => {
  // Grab a real id from the feed.
  const feed = (await (await fetch(`${base()}/api/feed?limit=50`)).json()) as {
    feed: Array<{ id: number }>;
  };
  const id = feed.feed[0].id;

  const present = await fetch(`${base()}/api/verdict/${id}`);
  assert.equal(present.status, 200);
  assert.equal(present.headers.get("cache-control"), "no-store");
  const pBody = (await present.json()) as { verdict: { id: number; source: string | null } };
  assert.equal(pBody.verdict.id, id);
  assert.equal(typeof pBody.verdict.source, "string", "verdict carries the source column");

  const absent = await fetch(`${base()}/api/verdict/999999`);
  assert.equal(absent.status, 404, "absent id → 404");
  assert.equal(absent.headers.get("cache-control"), "no-store");
  await absent.body?.cancel();

  const malformed = await fetch(`${base()}/api/verdict/not-a-number`);
  assert.equal(malformed.status, 400, "malformed id → 400");
  assert.equal(malformed.headers.get("cache-control"), "no-store");
  await malformed.body?.cancel();
});

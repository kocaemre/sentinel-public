import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeQueries, type Queries } from "./queries.js";

/**
 * Read-path proof for the dashboard's read queries (OBS-02/03).
 *
 * Strategy: seed a temp SQLite file with the AUTHORITATIVE `audit` schema (04-02-SUMMARY)
 * + a few rows (one settled allow, two blocks with different matched_attack), then open
 * it `{ readonly: true }` exactly as `db.ts` does and bind `makeQueries`. We test
 * `queries.ts` (the pure read core) directly: `db.ts` adds only the `import "server-only"`
 * boundary + the read-only open, and `server-only` throws under a plain node:test runner
 * (it is meant to fail outside an RSC bundle), so the pure core is the unit-test surface.
 * The protected BigInt sum is checked EXACTLY (never float).
 *
 * Runner: node:test (NOT vitest). The repo (proxy/test/*) uses node:test; the plan's
 * verify block named vitest — Rule 3 tooling-reality deviation, documented in SUMMARY.
 */

let dir: string;
let dbPath: string;
let q: Queries;

// The exact `audit` DDL the proxy uses (proxy/src/policy/audit.ts), mirrored for seeding.
const AUDIT_DDL =
  "CREATE TABLE IF NOT EXISTS audit (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
  "decided_at INTEGER NOT NULL, " +
  "decision TEXT NOT NULL, " +
  "control TEXT, " +
  "matched_attack TEXT, " +
  "injection_detected INTEGER, " +
  "reasons TEXT, " +
  "amount_atomic TEXT, " +
  "protected_atomic TEXT, " +
  "target_host TEXT, " +
  "resource TEXT, " +
  "settlement_tx TEXT" +
  ")";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinel-dash-"));
  dbPath = join(dir, "sentinel-wallet.db");

  // Seed as a normal writer (simulating the proxy), then close.
  const seed = new Database(dbPath);
  seed.pragma("journal_mode = WAL");
  seed.exec(AUDIT_DDL);
  const ins = seed.prepare(
    "INSERT INTO audit (decided_at, decision, control, matched_attack, injection_detected, " +
      "reasons, amount_atomic, protected_atomic, target_host, resource, settlement_tx) VALUES (" +
      "@decided_at, @decision, @control, @matched_attack, @injection_detected, " +
      "@reasons, @amount_atomic, @protected_atomic, @target_host, @resource, @settlement_tx)",
  );

  // 1) A settled legit allow — carries a real tx hash, no protected amount.
  ins.run({
    decided_at: 1000,
    decision: "allow",
    control: null,
    matched_attack: null,
    injection_detected: 0,
    reasons: JSON.stringify(["within per-call cap", "payee allowed"]),
    amount_atomic: "1000",
    protected_atomic: null,
    target_host: "api.example.com",
    resource: "/paid",
    settlement_tx: "0xabc123",
  });

  // 2) A blocked prompt-injection — the killer-demo catch (protected 50 USDC = 50_000_000 atomic).
  ins.run({
    decided_at: 2000,
    decision: "block",
    control: "judge",
    matched_attack: "prompt_injection_payment",
    injection_detected: 1,
    reasons: JSON.stringify(["injected instruction in 402 description"]),
    amount_atomic: "50000000",
    protected_atomic: "50000000",
    target_host: "evil.example.com",
    resource: "/paid-injected",
    settlement_tx: null,
  });

  // 3) A blocked overpayment drain (protected 1 atomic — tiny, to prove BigInt exactness).
  ins.run({
    decided_at: 3000,
    decision: "block",
    control: "overpayment",
    matched_attack: "overpayment_drain",
    injection_detected: 0,
    reasons: JSON.stringify(["amount exceeds priced resource"]),
    amount_atomic: "1",
    protected_atomic: "1",
    target_host: "evil.example.com",
    resource: "/paid-overpriced",
    settlement_tx: null,
  });

  seed.close();

  // Open read-only exactly as db.ts does, and bind the pure queries.
  const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
  q = makeQueries(ro);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("getMetrics returns screened/blocked + exact BigInt protected sum (never float)", () => {
  const m = q.getMetrics();
  assert.equal(m.screened, 3, "3 total decisions screened");
  assert.equal(m.blocked, 2, "2 non-allow decisions blocked");
  // 50_000_000 + 1 summed in BigInt — exact, never a float that would round.
  assert.equal(m.protectedAtomic, "50000001");
  assert.equal(typeof m.protectedAtomic, "string");
});

test("getFeed returns recent rows most-recent-first", () => {
  const feed = q.getFeed(10);
  assert.equal(feed.length, 3);
  // ORDER BY id DESC → the last-inserted (overpayment_drain) is first.
  assert.equal(feed[0].matched_attack, "overpayment_drain");
  assert.equal(feed[2].decision, "allow");
  assert.equal(feed[2].settlement_tx, "0xabc123");
});

test("getFeed respects the limit", () => {
  assert.equal(q.getFeed(1).length, 1);
});

test("getVerdict returns one row by id with the full drill-down fields", () => {
  const injectionRow = q
    .getFeed(10)
    .find((r) => r.matched_attack === "prompt_injection_payment");
  assert.ok(injectionRow, "the injection block row exists");
  const v = q.getVerdict(injectionRow!.id);
  assert.ok(v);
  assert.equal(v!.decision, "block");
  assert.equal(v!.injection_detected, 1);
  assert.equal(v!.matched_attack, "prompt_injection_payment");
  assert.equal(v!.protected_atomic, "50000000");
  assert.equal(v!.settlement_tx, null);
  assert.deepEqual(JSON.parse(v!.reasons!), [
    "injected instruction in 402 description",
  ]);
});

test("getVerdict returns undefined for an absent id", () => {
  assert.equal(q.getVerdict(99999), undefined);
});

test("getAttacksByType groups blocked rows on matched_attack", () => {
  const buckets = q.getAttacksByType();
  const map = new Map(buckets.map((b) => [b.matched_attack, b.count]));
  assert.equal(map.get("prompt_injection_payment"), 1);
  assert.equal(map.get("overpayment_drain"), 1);
  // The allow row is NOT counted (decision != 'allow' filter).
  assert.equal(buckets.reduce((s, b) => s + b.count, 0), 2);
});

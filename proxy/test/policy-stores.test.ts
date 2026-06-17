import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDedup, type Dedup } from "../src/policy/dedup.js";
import { openLedger, type Ledger } from "../src/policy/ledger.js";

/**
 * Task 1 unit proof for the two SQLite stores backing Plan 03's stateful controls:
 *
 *  - dedup (replay, POLICY-06): atomic first-seen over the canonical
 *    `(paymentId, resourceId)` key (NOT a per-call nonce). `markFirstSeen` is true
 *    the first time and false (replay) the second; a different paymentId OR
 *    resourceId never collides (length-prefix safety, RESEARCH Pitfall 3); the
 *    read-only `wasSeen` reports state without inserting (PRE/POST evaluate, Pitfall 1).
 *  - ledger (budget/velocity, POLICY-02/03): a rolling-window settlements table —
 *    `velocityCount`/`spentSince` over an injectable `now`, atomic-unit BigInt sums.
 *
 * Each test uses an isolated temp-file db (a real file, since `markFirstSeen`/`wasSeen`
 * must observe the same row across calls; `:memory:` would also work per-handle).
 */

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sentinel-stores-"));
  dbPath = join(tmpDir, "stores.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── dedup ──────────────────────────────────────────────────────────────────

test("dedup: markFirstSeen is true the first time, false (replay) the second", () => {
  const dedup: Dedup = openDedup(dbPath);
  assert.equal(dedup.markFirstSeen("payA", "resA"), true, "first-seen → true");
  assert.equal(dedup.markFirstSeen("payA", "resA"), false, "exact replay → false");
});

test("dedup: a different paymentId OR resourceId does NOT collide (no false replay)", () => {
  const dedup = openDedup(dbPath);
  assert.equal(dedup.markFirstSeen("payA", "resA"), true);
  assert.equal(dedup.markFirstSeen("payB", "resA"), true, "different paymentId → first-seen");
  assert.equal(dedup.markFirstSeen("payA", "resB"), true, "different resourceId → first-seen");
});

test("dedup: length-prefix safety — boundary-shifted parts never alias (RESEARCH Pitfall 3)", () => {
  const dedup = openDedup(dbPath);
  // With a bare separator these two distinct tuples would collide:
  //   ("a", "b") vs ("a|b", "") vs ("a", "|b")
  assert.equal(dedup.markFirstSeen("a", "b"), true);
  assert.equal(dedup.markFirstSeen("a|b", ""), true, "must NOT alias ('a','b')");
  assert.equal(dedup.markFirstSeen("a", "|b"), true, "must NOT alias ('a','b')");
});

test("dedup: wasSeen reports state but does NOT itself insert (read-only evaluate, Pitfall 1)", () => {
  const dedup = openDedup(dbPath);
  assert.equal(dedup.wasSeen("payA", "resA"), false, "unseen before any mark");
  // Calling wasSeen repeatedly must NOT mark first-seen.
  assert.equal(dedup.wasSeen("payA", "resA"), false, "still unseen — wasSeen never inserts");
  assert.equal(dedup.markFirstSeen("payA", "resA"), true, "markFirstSeen still gets the first-seen");
  assert.equal(dedup.wasSeen("payA", "resA"), true, "now seen after markFirstSeen");
});

// ── ledger ─────────────────────────────────────────────────────────────────

test("ledger: an empty table reports zero count and zero spend", () => {
  const ledger: Ledger = openLedger(dbPath);
  assert.equal(ledger.velocityCount(60_000), 0);
  assert.equal(ledger.spentSince(3_600_000), 0n);
});

test("ledger: recordSettlement accumulates count + atomic-unit BigInt sum in-window", () => {
  const ledger = openLedger(dbPath);
  ledger.recordSettlement(1_000_000n);
  ledger.recordSettlement(1_000_000n);
  ledger.recordSettlement(1_000_000n);
  assert.equal(ledger.velocityCount(60_000), 3);
  assert.equal(ledger.spentSince(3_600_000), 3_000_000n, "sum is atomic BigInt, no float drift");
});

test("ledger: a settlement older than the window is EXCLUDED (rolling >= now-window)", () => {
  const ledger = openLedger(dbPath);
  const t0 = 1_000_000_000_000; // fixed epoch ms for determinism
  // One settlement 2h ago, one 30s ago.
  ledger.recordSettlement(5_000_000n, t0 - 2 * 3_600_000);
  ledger.recordSettlement(2_000_000n, t0 - 30_000);
  // 1h window at t0: only the 30s-ago settlement counts.
  assert.equal(ledger.velocityCount(3_600_000, t0), 1, "the 2h-old one is outside the 1h window");
  assert.equal(ledger.spentSince(3_600_000, t0), 2_000_000n);
  // 3h window at t0: both count.
  assert.equal(ledger.velocityCount(3 * 3_600_000, t0), 2);
  assert.equal(ledger.spentSince(3 * 3_600_000, t0), 7_000_000n);
});

test("ledger: spend sum stays exact for many atomic settlements (no float drift)", () => {
  const ledger = openLedger(dbPath);
  for (let i = 0; i < 1000; i++) ledger.recordSettlement(1n);
  assert.equal(ledger.spentSince(3_600_000), 1000n);
});

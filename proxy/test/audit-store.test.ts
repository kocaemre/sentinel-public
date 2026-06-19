import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAudit, type Audit, type AuditRow } from "../src/policy/audit.js";

/**
 * Task 1 unit proof for the append-only `audit` store (OBS-01, D-03).
 *
 * Mirrors `policy-stores.test.ts` (the ledger/dedup analog): an isolated temp-file
 * db per test, the typed `Audit` interface exercised directly. The audit store is
 * INSERT-only — these tests prove every decision persists exactly, money round-trips
 * as exact atomic TEXT (never a float), `injection_detected` is an INTEGER 0/1, the
 * dashboard reads (recentFeed/byId/metrics) return the persisted rows, `metrics()`
 * sums protected_atomic in JS BigInt (never SQLite float SUM), and the module source
 * contains NO UPDATE/DELETE statement (append-only enforced by code shape).
 */

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sentinel-audit-"));
  dbPath = join(tmpDir, "audit.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const allowRow = (over: Partial<AuditRow> = {}): AuditRow => ({
  decided_at: 1_000_000_000_000,
  decision: "allow",
  control: null,
  matched_attack: "none",
  injection_detected: 0,
  reasons: JSON.stringify(["clean"]),
  amount_atomic: "1000000",
  protected_atomic: null,
  target_host: "api.example.com",
  resource: "/paid",
  settlement_tx: "0xabc123",
  source: null,
  agent_label: null,
  ...over,
});

const blockRow = (over: Partial<AuditRow> = {}): AuditRow => ({
  decided_at: 1_000_000_000_001,
  decision: "block",
  control: "overpayment",
  matched_attack: "prompt_injection_payment",
  injection_detected: 1,
  reasons: JSON.stringify(["injection in description"]),
  amount_atomic: "50000000",
  protected_atomic: "50000000",
  target_host: "evil.example.com",
  resource: "/paid-overpriced",
  settlement_tx: null,
  source: null,
  agent_label: null,
  ...over,
});

test("audit: an allow (with settlement_tx) and a block (settlement_tx NULL) both persist and read back", () => {
  const audit: Audit = openAudit(dbPath);
  audit.insert(allowRow());
  audit.insert(blockRow());

  const feed = audit.recentFeed(10);
  assert.equal(feed.length, 2, "both rows persisted");

  // recentFeed is most-recent first: the block (decided_at later) leads.
  assert.equal(feed[0].decision, "block");
  assert.equal(feed[0].settlement_tx, null, "block carries settlement_tx NULL");
  assert.equal(feed[1].decision, "allow");
  assert.equal(feed[1].settlement_tx, "0xabc123", "allow carries the real settlement_tx");
});

test("audit: amount_atomic/protected_atomic round-trip as exact TEXT for a large atomic value (no float)", () => {
  const audit = openAudit(dbPath);
  audit.insert(blockRow({ amount_atomic: "50000000", protected_atomic: "50000000" }));
  const feed = audit.recentFeed(1);
  assert.equal(feed[0].amount_atomic, "50000000", "atomic amount is exact TEXT");
  assert.equal(feed[0].protected_atomic, "50000000", "protected atomic is exact TEXT");
  assert.equal(typeof feed[0].amount_atomic, "string", "money is TEXT, never a JS number");
});

test("audit: injection_detected persists as INTEGER 0/1 and reads back boolean-equivalent", () => {
  const audit = openAudit(dbPath);
  audit.insert(allowRow({ injection_detected: 0 }));
  audit.insert(blockRow({ injection_detected: 1 }));
  const feed = audit.recentFeed(10);
  // most-recent first → block (1) then allow (0)
  assert.equal(feed[0].injection_detected, 1);
  assert.equal(feed[1].injection_detected, 0);
});

test("audit: byId returns the drill-down row (and undefined for a missing id)", () => {
  const audit = openAudit(dbPath);
  audit.insert(blockRow());
  const feed = audit.recentFeed(1);
  const id = feed[0].id;
  assert.ok(typeof id === "number", "row carries an autoincrement id");
  const row = audit.byId(id);
  assert.ok(row, "byId resolves the inserted row");
  assert.equal(row!.decision, "block");
  assert.equal(row!.matched_attack, "prompt_injection_payment");
  assert.equal(audit.byId(999_999), undefined, "missing id → undefined");
});

test("audit: metrics() — screened COUNT, blocked COUNT (decision != 'allow'), protected SUM in BigInt", () => {
  const audit = openAudit(dbPath);
  audit.insert(allowRow()); // settled allow, no protected
  audit.insert(blockRow({ protected_atomic: "50000000" }));
  audit.insert(blockRow({ decision: "step-up", control: "velocity", protected_atomic: "1000000" }));

  const m = audit.metrics();
  assert.equal(m.screened, 3, "screened = COUNT(*)");
  assert.equal(m.blocked, 2, "blocked = COUNT WHERE decision != 'allow'");
  // 50000000 + 1000000 = 51000000, summed in JS BigInt, returned as a string.
  assert.equal(m.protectedAtomic, "51000000", "protected = BigInt sum of protected_atomic on non-allow rows");
  assert.equal(typeof m.protectedAtomic, "string", "protectedAtomic is a string, never a float");
});

test("audit: protected SUM stays exact for many tiny atomic blocks (no float drift)", () => {
  const audit = openAudit(dbPath);
  for (let i = 0; i < 1000; i++) {
    audit.insert(blockRow({ protected_atomic: "1" }));
  }
  assert.equal(audit.metrics().protectedAtomic, "1000", "BigInt sum, no float drift");
});

test("audit: source module contains NO UPDATE/DELETE statement (append-only by code shape, D-03)", () => {
  const auditSrc = fileURLToPath(new URL("../src/policy/audit.ts", import.meta.url));
  const src = readFileSync(auditSrc, "utf8");
  // Strip line + block comments so prose (e.g. "row-removing") never trips the gate.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.equal(/\bUPDATE\b/.test(code), false, "no UPDATE statement against audit");
  assert.equal(/\bDELETE\b/.test(code), false, "no DELETE statement against audit");
});

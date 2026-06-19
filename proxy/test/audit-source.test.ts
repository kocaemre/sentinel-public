import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openAudit, type Audit, type AuditRow } from "../src/policy/audit.js";

/**
 * Phase-5 Plan 01 Task 1 unit proof (DIST-02, D-06/D-07).
 *
 * Mirrors `audit-store.test.ts` (the isolated temp-file db per test, the typed
 * `Audit` interface exercised directly). These tests prove the ADDITIVE source/
 * agent_label migration:
 *   - openAudit on a fresh db creates source/agent_label; a row round-trips them.
 *   - re-opening a db that pre-dates the migration adds the columns idempotently;
 *     pre-existing rows read NULL for the new columns.
 *   - distinctAgents(devSource) counts DISTINCT non-null sources EXCLUDING devSource;
 *     null/"" devSource counts all non-null sources.
 *   - attacksByType() groups blocked rows by COALESCE(matched_attack,'unknown') desc —
 *     byte-identical to dashboard/lib/queries.ts getAttacksByType.
 *   - the module source contains NO UPDATE/DELETE token after the migration
 *     (append-only by code shape preserved through the ALTER TABLE ADD COLUMN).
 */

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sentinel-audit-source-"));
  dbPath = join(tmpDir, "audit.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const baseRow = (over: Partial<AuditRow> = {}): AuditRow => ({
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

const blockRow = (over: Partial<AuditRow> = {}): AuditRow =>
  baseRow({
    decision: "block",
    control: "per_call_cap",
    matched_attack: "prompt_injection_payment",
    injection_detected: 1,
    reasons: JSON.stringify(["injection in description"]),
    amount_atomic: "50000000",
    protected_atomic: "50000000",
    target_host: "evil.example.com",
    resource: "/paid-overpriced",
    settlement_tx: null,
    ...over,
  });

test("audit-source: openAudit creates source/agent_label; a row round-trips both exactly", () => {
  const audit: Audit = openAudit(dbPath);
  audit.insert(baseRow({ source: "203.0.113.7", agent_label: "smoke-bot" }));
  const feed = audit.recentFeed(1);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].source, "203.0.113.7", "source round-trips exactly");
  assert.equal(feed[0].agent_label, "smoke-bot", "agent_label round-trips exactly");
});

test("audit-source: an inserted row with NULL source/agent_label reads back null", () => {
  const audit = openAudit(dbPath);
  audit.insert(baseRow({ source: null, agent_label: null }));
  const row = audit.recentFeed(1)[0];
  assert.equal(row.source, null, "null source reads back null");
  assert.equal(row.agent_label, null, "null agent_label reads back null");
});

test("audit-source: re-opening a pre-migration db adds the columns idempotently; old rows read NULL", () => {
  // Simulate a db created by the PRE-Phase-5 schema (no source/agent_label columns)
  // with a row already present, then run the migration via openAudit.
  const legacy = new Database(dbPath);
  legacy.pragma("journal_mode = WAL");
  legacy.exec(
    "CREATE TABLE IF NOT EXISTS audit (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, decided_at INTEGER NOT NULL, decision TEXT NOT NULL, " +
      "control TEXT, matched_attack TEXT, injection_detected INTEGER, reasons TEXT, " +
      "amount_atomic TEXT, protected_atomic TEXT, target_host TEXT, resource TEXT, settlement_tx TEXT)",
  );
  legacy
    .prepare(
      "INSERT INTO audit (decided_at, decision, matched_attack, injection_detected) VALUES (?,?,?,?)",
    )
    .run(1_000_000_000_000, "allow", "none", 0);
  legacy.close();

  // First openAudit runs the additive migration. The pre-existing row reads NULL.
  const audit = openAudit(dbPath);
  const old = audit.recentFeed(1)[0];
  assert.equal(old.source, null, "a pre-migration row reads NULL source");
  assert.equal(old.agent_label, null, "a pre-migration row reads NULL agent_label");

  // A new row written after the migration carries the values.
  audit.insert(baseRow({ source: "198.51.100.9", agent_label: "late-bot" }));
  const fresh = audit.recentFeed(1)[0];
  assert.equal(fresh.source, "198.51.100.9");
  assert.equal(fresh.agent_label, "late-bot");

  // Idempotent: re-opening again does not throw (no duplicate ADD COLUMN).
  assert.doesNotThrow(() => openAudit(dbPath), "re-running the migration is a no-op");
});

test("audit-source: distinctAgents(devSource) counts distinct non-null sources excluding the dev", () => {
  const audit = openAudit(dbPath);
  audit.insert(baseRow({ source: "10.0.0.1" })); // dev
  audit.insert(baseRow({ source: "10.0.0.1" })); // dev again (same distinct value)
  audit.insert(baseRow({ source: "203.0.113.7" })); // external A
  audit.insert(baseRow({ source: "203.0.113.8" })); // external B
  audit.insert(baseRow({ source: null })); // no source — never counted

  // Excluding the dev source 10.0.0.1 → only A + B = 2 distinct external agents.
  assert.equal(audit.distinctAgents("10.0.0.1"), 2, "dev source excluded from N");

  // No exclusion (null) → all three distinct non-null sources counted.
  assert.equal(audit.distinctAgents(null), 3, "null devSource counts all non-null sources");

  // Empty-string devSource is treated as no exclusion (unset SENTINEL_DEV_SOURCE).
  assert.equal(audit.distinctAgents(""), 3, "empty devSource counts all non-null sources");
});

test("audit-source: attacksByType groups blocked rows by COALESCE(matched_attack,'unknown') desc", () => {
  const audit = openAudit(dbPath);
  // Two prompt_injection blocks, one replay block, one block with NULL matched_attack,
  // plus an allow (must NOT appear — only decision != 'allow' rows are bucketed).
  audit.insert(blockRow({ matched_attack: "prompt_injection_payment" }));
  audit.insert(blockRow({ matched_attack: "prompt_injection_payment" }));
  audit.insert(blockRow({ matched_attack: "replay" }));
  audit.insert(blockRow({ matched_attack: null }));
  audit.insert(baseRow({ decision: "allow", matched_attack: "none" }));

  const buckets = audit.attacksByType();
  // Highest count first: prompt_injection_payment (2), then replay (1) + unknown (1).
  assert.equal(buckets[0].matched_attack, "prompt_injection_payment");
  assert.equal(buckets[0].count, 2, "two prompt_injection blocks bucketed together");
  const names = buckets.map((b) => b.matched_attack);
  assert.ok(names.includes("replay"), "replay bucket present");
  assert.ok(names.includes("unknown"), "NULL matched_attack folded into 'unknown'");
  // The allow is never bucketed.
  const total = buckets.reduce((s, b) => s + b.count, 0);
  assert.equal(total, 4, "only the 4 non-allow rows are bucketed (allow excluded)");
});

test("audit-source: module source contains NO UPDATE/DELETE statement after the migration (D-03/T-05-04)", () => {
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
  // The migration is additive ALTER TABLE ADD COLUMN, and the honest-N query exists.
  assert.ok(/ALTER TABLE/.test(code), "additive ALTER TABLE present");
  assert.ok(/COUNT\(DISTINCT source\)/.test(code), "distinct-source honest-N query present");
});

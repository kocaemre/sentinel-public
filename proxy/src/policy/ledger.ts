/**
 * Rolling-window settlements ledger (POLICY-02 budget + POLICY-03 velocity,
 * threat T-02-12/15/16).
 *
 * Every CONFIRMED settlement (an upstream 200 after the X-PAYMENT replay) appends
 * one row to `settlements(amount_atomic TEXT, settled_at INTEGER)`. The two read
 * controls query a rolling window relative to `now`:
 *
 *  - `velocityCount(windowMs)`  — COUNT of settlements with `settled_at >= now-window`
 *    (POLICY-03: the Nth+1 payment inside the window trips velocity).
 *  - `spentSince(windowMs)`     — SUM of `amount_atomic` (as BigInt) over the window
 *    (POLICY-02: the rolling hourly/daily budget).
 *
 * Money is atomic-unit `BigInt` stored as TEXT — NEVER a JS float (RESEARCH
 * Pattern 3 / Pitfall 4), so the budget sum stays exact for any number of tiny
 * settlements. `now` is injectable so tests can place settlements outside the
 * window deterministically.
 *
 * Commit-once (RESEARCH Pitfall 1 + 2): the engine's controls only READ this ledger
 * (in both the PRE and POST evaluate passes). `recordSettlement` is the single
 * WRITE and is called EXACTLY ONCE, from forward.ts, AFTER the upstream 200 — so a
 * blocked or failed-retry payment never counts toward budget/velocity.
 *
 * Convention (mirrors wallet.ts / dedup.ts): the db path is a PARAMETER. This
 * `settlements` table lives in the SAME SQLite file as the Plan 01 `wallet` row and
 * the dedup `seen_payments` table.
 */

import Database from "better-sqlite3";

/** A handle over the `settlements` table in one SQLite file. */
export interface Ledger {
  /** Count of settlements within the last `windowMs` (POLICY-03 velocity). */
  velocityCount(windowMs: number, now?: number): number;
  /** Atomic-unit BigInt sum of settlements within the last `windowMs` (POLICY-02 budget). */
  spentSince(windowMs: number, now?: number): bigint;
  /** Append ONE confirmed settlement (called once post-settlement in forward.ts). */
  recordSettlement(amountAtomic: bigint, now?: number): void;
}

/**
 * Open (or create) the settlements ledger at `dbPath`.
 *
 * @param dbPath SQLite file path, or `":memory:"` for a per-connection ephemeral db.
 */
export function openLedger(dbPath: string): Ledger {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS settlements (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "amount_atomic TEXT NOT NULL, " +
      "settled_at INTEGER NOT NULL" +
      ")",
  );

  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE settled_at >= ?");
  const sumStmt = db.prepare(
    "SELECT amount_atomic FROM settlements WHERE settled_at >= ?",
  );
  const insertStmt = db.prepare(
    "INSERT INTO settlements (amount_atomic, settled_at) VALUES (@amount, @at)",
  );

  function velocityCount(windowMs: number, now: number = Date.now()): number {
    const row = countStmt.get(now - windowMs) as { n: number };
    return row.n;
  }

  function spentSince(windowMs: number, now: number = Date.now()): bigint {
    // Sum in BigInt, never SQLite's float SUM() — money math stays exact.
    const rows = sumStmt.all(now - windowMs) as Array<{ amount_atomic: string }>;
    let total = 0n;
    for (const r of rows) total += BigInt(r.amount_atomic);
    return total;
  }

  function recordSettlement(amountAtomic: bigint, now: number = Date.now()): void {
    insertStmt.run({ amount: amountAtomic.toString(), at: now });
  }

  return { velocityCount, spentSince, recordSettlement };
}

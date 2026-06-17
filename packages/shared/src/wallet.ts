/**
 * Shared simulated-balance store for the wallet-drain demo (Plan 02-01, Task 1).
 *
 * The "wallet" is a single row in ONE SQLite file. Both processes that matter —
 * the reference-agent (which decrements on settle) and the proxy (whose Plan 02
 * gate will preserve the balance) — open the same file and observe each other's
 * writes. This is the shared-store invariant that makes the drain-vs-preserve
 * contrast real: a true bypass drains the balance the proxy would have protected
 * (RESEARCH Pitfall 5; Open Q1 resolved to a shared SQLite `wallet` row).
 *
 * Money is always atomic-unit `BigInt` (1 USDC = 1_000_000 atomic), stored as
 * TEXT so there is no JS-float drift (RESEARCH Pattern 3 / Pitfall 4). The single
 * row is pinned with `CHECK (id = 1)`; every settle runs inside a synchronous
 * `db.transaction` — better-sqlite3 is synchronous so there is no event-loop
 * interleaving inside a statement, and the read-modify-write cannot race in JS
 * (threat T-02-02).
 *
 * Convention: the db path is a PARAMETER, never read from `process.env` inside
 * this module (validate/derive at the boundary, pass handles in — PATTERNS
 * §"No Analog Found", mirrors `config.ts`). Tests pass `:memory:` or a temp file.
 */

import Database from "better-sqlite3";

/** A handle over the single-row `wallet` table in one SQLite file. */
export interface Wallet {
  /** Current balance in atomic units (1 USDC = 1_000_000). 0n if never reset. */
  getBalanceAtomic(): bigint;
  /** Decrement the balance by `amountAtomic` (atomic units). May go negative (drain). */
  settle(amountAtomic: bigint): void;
  /** Set the balance to `atomic` (e.g. 100_000_000n = 100 USDC) — the demo starting point. */
  resetBalance(atomic: bigint): void;
}

/**
 * Open (or create) the shared simulated wallet at `dbPath`.
 *
 * @param dbPath SQLite file path, or `":memory:"` for a per-connection ephemeral db.
 *               Use a real file path when two handles must share state.
 */
export function openWallet(dbPath: string): Wallet {
  const db = new Database(dbPath);
  // WAL improves concurrent reader/writer behavior across the agent + proxy
  // processes that share the file (RESEARCH §"Standard Stack").
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS wallet (" +
      "id INTEGER PRIMARY KEY CHECK (id = 1), " +
      "balance_atomic TEXT NOT NULL" +
      ")",
  );

  const selectStmt = db.prepare("SELECT balance_atomic FROM wallet WHERE id = 1");
  const upsertStmt = db.prepare(
    "INSERT INTO wallet (id, balance_atomic) VALUES (1, @balance) " +
      "ON CONFLICT(id) DO UPDATE SET balance_atomic = @balance",
  );

  function getBalanceAtomic(): bigint {
    const row = selectStmt.get() as { balance_atomic: string } | undefined;
    // No row yet → treat as 0 (the demo always resetBalance()s before settling).
    return row ? BigInt(row.balance_atomic) : 0n;
  }

  function resetBalance(atomic: bigint): void {
    upsertStmt.run({ balance: atomic.toString() });
  }

  // Read-modify-write the single row atomically. better-sqlite3 transactions are
  // synchronous, so the read and write are not interleavable (threat T-02-02).
  const settleTxn = db.transaction((amountAtomic: bigint) => {
    const next = getBalanceAtomic() - amountAtomic; // BigInt math, never a float
    upsertStmt.run({ balance: next.toString() });
  });

  function settle(amountAtomic: bigint): void {
    settleTxn(amountAtomic);
  }

  return { getBalanceAtomic, settle, resetBalance };
}

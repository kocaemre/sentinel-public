/**
 * Atomic HTTP-layer replay-dedup store (POLICY-06, D-11, threat T-02-10/14/18).
 *
 * The dedup keys on the canonical `(paymentId, resourceId)` pair where
 * `paymentId = canonicalPaymentId(requirements)` (proxy/src/policy/identity.ts) —
 * the STABLE upstream-402 payment-defining fields — and `resourceId =
 * requirements.resource`. It does NOT key on Sentinel's per-call X-PAYMENT nonce:
 * `build.ts` mints a fresh 32-byte nonce per proxied call, so keying on that nonce
 * would no-op the dedup in the proxied path (two identical agent requests → two
 * distinct nonces → both granted, threat T-02-17). Keying on the canonical pair
 * means "the same logical payment requested twice THROUGH Sentinel" collides — so
 * the second is blocked (SC#4).
 *
 * Atomicity (threat T-02-14, TOCTOU): there is NO check-then-act. `markFirstSeen`
 * is a single `INSERT ... ON CONFLICT DO NOTHING` over a `PRIMARY KEY` column;
 * `info.changes === 1` means we won the first-seen, `=== 0` means a row already
 * existed (replay). better-sqlite3 is synchronous, so the INSERT cannot interleave
 * with another in-flight request within a statement. The read-only `wasSeen` is
 * the PRE/POST evaluate path and NEVER inserts (RESEARCH Pitfall 1) — the single
 * COMMIT happens once at the allow decision point in decide.ts.
 *
 * Convention (mirrors wallet.ts / config.ts): the db path is a PARAMETER, never
 * read from `process.env` inside this module. The same gitignored SQLite file
 * holds the Plan 01 `wallet` row, this `seen_payments` table, and the ledger's
 * `settlements` table (Phase 4 reuses the file for its audit log).
 */

import Database from "better-sqlite3";

/** A handle over the `seen_payments` table in one SQLite file. */
export interface Dedup {
  /**
   * Atomically claim first-seen for the canonical `(paymentId, resourceId)` pair.
   * Returns `true` on the FIRST sighting (we inserted the row) and `false` on a
   * REPLAY (a row already existed). The single COMMIT for the replay control.
   */
  markFirstSeen(paymentId: string, resourceId: string): boolean;
  /**
   * Read-only existence check for the PRE/POST evaluate path — `true` if the pair
   * was already marked first-seen. NEVER inserts (so PRE and POST can both call it
   * without double-marking — RESEARCH Pitfall 1).
   */
  wasSeen(paymentId: string, resourceId: string): boolean;
}

/**
 * Length-prefixed, delimiter-safe join of the two key parts (RESEARCH Pitfall 3).
 *
 * BOTH `paymentId` (a canonical encoding) and `resourceId` (an arbitrary URL) are
 * attacker/URL-derived strings, so a bare separator is NOT safe — `("a", "b")`
 * would alias `("a|b", "")`. Emitting each part as `<byteLength>:<value>` makes the
 * boundary unambiguous, so no two distinct pairs can ever collide.
 */
function dedupKey(paymentId: string, resourceId: string): string {
  return (
    `${Buffer.byteLength(paymentId, "utf8")}:${paymentId}` +
    "|" +
    `${Buffer.byteLength(resourceId, "utf8")}:${resourceId}`
  );
}

/**
 * Open (or create) the replay-dedup store at `dbPath`.
 *
 * @param dbPath SQLite file path, or `":memory:"` for a per-connection ephemeral db.
 *               Use a real file path when two handles must share state.
 */
export function openDedup(dbPath: string): Dedup {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS seen_payments (" +
      "payment_key TEXT PRIMARY KEY, " +
      "seen_at INTEGER NOT NULL" +
      ")",
  );

  // Atomic first-seen: PRIMARY KEY + ON CONFLICT DO NOTHING. changes===1 ⇒ won the
  // race (first-seen); changes===0 ⇒ a row already existed (replay → block).
  const insertStmt = db.prepare(
    "INSERT INTO seen_payments (payment_key, seen_at) VALUES (@key, @at) " +
      "ON CONFLICT DO NOTHING",
  );
  // Read-only existence check — NEVER inserts (PRE/POST evaluate, Pitfall 1).
  const selectStmt = db.prepare("SELECT 1 FROM seen_payments WHERE payment_key = ? LIMIT 1");

  function markFirstSeen(paymentId: string, resourceId: string): boolean {
    const info = insertStmt.run({ key: dedupKey(paymentId, resourceId), at: Date.now() });
    return info.changes === 1;
  }

  function wasSeen(paymentId: string, resourceId: string): boolean {
    return selectStmt.get(dedupKey(paymentId, resourceId)) !== undefined;
  }

  return { markFirstSeen, wasSeen };
}

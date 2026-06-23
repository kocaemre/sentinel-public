/**
 * Pure read queries over the shared `audit` table — the testable core of the
 * dashboard's read path (OBS-02/03).
 *
 * This module holds NO `server-only` guard and NO db-opening side effect: it takes a
 * `better-sqlite3` Database instance and exposes the prepared-statement reads. `db.ts`
 * (which IS `server-only` and opens the shared file `{ readonly: true }`) wraps these;
 * `db.test.ts` exercises them directly against a seeded temp file. Splitting the pure
 * reads out keeps the `server-only` boundary in `db.ts` (so the native module never
 * leaks to a client bundle) while keeping the query logic unit-testable under node:test.
 *
 * MONEY IS BIGINT (threat T-04-08): `protectedSum` folds `protected_atomic` TEXT in JS
 * BigInt — NEVER a SQLite float `SUM()` — mirroring proxy `ledger.spentSince`.
 * The column schema is AUTHORITATIVE per 04-02-SUMMARY.md.
 */
import type { Database as DB } from "better-sqlite3";

/** One persisted audit row, as read back from the shared `audit` table. */
export interface AuditRecord {
  id: number;
  /** Epoch ms when the decision was made (`Date.now()`). */
  decided_at: number;
  /** The verdict: `allow` | `block` | `step-up`. */
  decision: string;
  /** The named deterministic control that produced a block, else null. */
  control: string | null;
  /** The advisory matched attack class, else null. */
  matched_attack: string | null;
  /** The judge's advisory injection flag as INTEGER 0/1, else null. */
  injection_detected: number | null;
  /** JSON-stringified `reasons[]`, else null. */
  reasons: string | null;
  /** Payment amount in atomic units, exact TEXT (never a float), else null. */
  amount_atomic: string | null;
  /** Atomic-unit amount protected by a block, exact TEXT, null on an allow. */
  protected_atomic: string | null;
  /** Upstream host the agent was paying. */
  target_host: string | null;
  /** x402 resource path. */
  resource: string | null;
  /** Real Arc-testnet settlement tx hash on a settled allow; null otherwise. */
  settlement_tx: string | null;
}

/** Three headline metrics for the dashboard (OBS-02). */
export interface DashboardMetrics {
  /** Payments screened = COUNT(*) of all decisions. */
  screened: number;
  /** Attacks blocked = COUNT WHERE decision != 'allow'. */
  blocked: number;
  /** USDC protected = JS-BigInt SUM of `protected_atomic` over blocked rows, as a string. */
  protectedAtomic: string;
  /**
   * Distinct external agents (by `CF-Connecting-IP`), the developer excluded (D-06/D-07).
   * Carried by the proxy's `/api/metrics` endpoint (Plan 01); optional here so the pure
   * SQLite `makeQueries` core (which does not compute it) still satisfies the type.
   */
  distinctAgents?: number;
}

/** One attacks-blocked-by-type bucket (OBS-03), grouped on `matched_attack`. */
export interface AttackBucket {
  /** The matched-attack class, or "unknown" when null (a deterministic-only block). */
  matched_attack: string;
  /** How many blocked rows carry this class. */
  count: number;
}

/** Prepared read statements bound to one db handle. */
export interface Queries {
  getMetrics(): DashboardMetrics;
  getFeed(limit: number): AuditRecord[];
  getVerdict(id: number): AuditRecord | undefined;
  getAttacksByType(): AttackBucket[];
}

/**
 * Bind the dashboard read queries to a `better-sqlite3` handle.
 *
 * The caller owns opening the db (read-only in production via `db.ts`). This function
 * only PREPARES read statements — it issues no writes.
 */
export function makeQueries(db: DB): Queries {
  const recent = db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?");
  const byId = db.prepare("SELECT * FROM audit WHERE id = ?");
  // Fold protected_atomic in BigInt below — never SQLite float SUM().
  const protectedRows = db.prepare(
    "SELECT protected_atomic FROM audit WHERE decision != 'allow' AND protected_atomic IS NOT NULL",
  );
  const screenedStmt = db.prepare("SELECT COUNT(*) AS n FROM audit");
  const blockedStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM audit WHERE decision != 'allow'",
  );
  const byType = db.prepare(
    "SELECT COALESCE(matched_attack, 'unknown') AS matched_attack, COUNT(*) AS count " +
      "FROM audit WHERE decision != 'allow' " +
      "GROUP BY COALESCE(matched_attack, 'unknown') ORDER BY count DESC",
  );

  return {
    getMetrics(): DashboardMetrics {
      const screened = (screenedStmt.get() as { n: number }).n;
      const blocked = (blockedStmt.get() as { n: number }).n;
      const rows = protectedRows.all() as Array<{ protected_atomic: string }>;
      let total = 0n;
      for (const r of rows) total += BigInt(r.protected_atomic);
      return { screened, blocked, protectedAtomic: total.toString() };
    },
    getFeed(limit: number): AuditRecord[] {
      return recent.all(limit) as AuditRecord[];
    },
    getVerdict(id: number): AuditRecord | undefined {
      return byId.get(id) as AuditRecord | undefined;
    },
    getAttacksByType(): AttackBucket[] {
      return byType.all() as AttackBucket[];
    },
  };
}

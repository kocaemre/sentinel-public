/**
 * Server-only READ-ONLY handle on the shared Sentinel SQLite file (OBS-02/03).
 *
 * The proxy is the SOLE WRITER of this file (it appends one `audit` row per decision —
 * see proxy/src/policy/audit.ts). The dashboard opens the SAME file
 * `{ readonly: true, fileMustExist: true }` so it can NEVER tamper with the append-only
 * audit log (threat T-04-10) and so a missing/mispointed `SENTINEL_DB_PATH` fails loud
 * rather than silently creating an empty divergent db. WAL (set by the proxy) allows
 * this concurrent reader (RESEARCH Pattern 3 / Pitfall 5).
 *
 * `import "server-only"` (threat T-04-12/13): this module is a native Node addon
 * (better-sqlite3) and must never reach the client bundle or an edge runtime — the
 * import throws at build time if a `"use client"` file ever imports it. Route handlers
 * that consume this set `export const runtime = "nodejs"`.
 *
 * The pure read queries live in `./queries` (no `server-only`, no open side effect) so
 * they stay unit-testable; this module owns ONLY the server-only boundary + the
 * read-only open. The column schema is AUTHORITATIVE per 04-02-SUMMARY.md.
 */
import "server-only";
import Database from "better-sqlite3";
import { makeQueries, type Queries } from "./queries";

export type {
  AuditRecord,
  DashboardMetrics,
  AttackBucket,
} from "./queries";

/**
 * Lazily open the shared db read-only and cache the bound queries.
 *
 * Opening is deferred to first read (not module load) so `next build` — which evaluates
 * route modules without `SENTINEL_DB_PATH` set and without the proxy's db file on disk —
 * never crashes. A real request with a missing/mispointed path throws a clear error.
 */
let cached: Queries | null = null;

function queries(): Queries {
  if (cached) return cached;

  const dbPath = process.env.SENTINEL_DB_PATH;
  if (!dbPath) {
    throw new Error(
      "SENTINEL_DB_PATH is not set — point it at the SAME SQLite file the proxy writes (e.g. proxy/sentinel-wallet.db).",
    );
  }

  // SOLE-WRITER invariant: the dashboard opens read-only and must-exist. It never
  // writes; the proxy is the only writer (threat T-04-10).
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  cached = makeQueries(db);
  return cached;
}

/** The three headline numbers; `protectedAtomic` summed in JS BigInt, never float. */
export function getMetrics() {
  return queries().getMetrics();
}

/** Most-recent decisions first, capped at `limit` — the live verdict feed (OBS-02). */
export function getFeed(limit: number) {
  return queries().getFeed(limit);
}

/** A single decision by id — the per-verdict drill-down (OBS-03), or undefined. */
export function getVerdict(id: number) {
  return queries().getVerdict(id);
}

/** Attacks-blocked-by-type, grouped on `matched_attack` over blocked rows (OBS-03). */
export function getAttacksByType() {
  return queries().getAttacksByType();
}

/**
 * Append-only decision audit log (OBS-01, threat T-04-06).
 *
 * Every decision the proxy makes — allow / block / step-up plus the rationale —
 * appends ONE row to `audit` in the SAME better-sqlite3 file as the Plan 01/02
 * `wallet` / `settlements` / `seen_payments` tables. This is the single, consistent
 * source of truth the live dashboard (Plan 03) reads from.
 *
 * APPEND-ONLY BY CODE SHAPE (D-03, threat T-04-06): the only write statement against
 * `audit` is the insert below — there is no row-mutating or row-removing statement
 * anywhere in this module (or the codebase). Tamper-resistance is enforced by the
 * shape of the code, not a runtime flag. A grep for the SQL mutate/remove keywords
 * on this file returns nothing — the append-only guarantee is grep-verifiable. The
 * Phase-5 source/agent_label migration is ADDITIVE DDL only (ALTER TABLE ADD COLUMN);
 * additive schema DDL is NOT a row mutation, so the invariant holds (D-07, T-05-04).
 *
 * MONEY IS ATOMIC-UNIT TEXT (threat T-04-08): `amount_atomic` / `protected_atomic`
 * are stored as the atomic-unit BigInt's `.toString()` — NEVER a JS float. `metrics()`
 * sums `protected_atomic` in JS BigInt (NEVER SQLite's float `SUM()`), exactly
 * mirroring `ledger.spentSince` (ledger.ts:70-76), so the headline USDC-protected
 * number stays exact for any number of tiny blocks.
 *
 * SECRETS (threat T-04-07): a row carries only `settlement_tx` (a public tx hash) —
 * never the signing key. `SENTINEL_WALLET_PRIVATE_KEY` is never passed to `insert`.
 *
 * STORED-INJECTION (threat T-04-09 / T-05-03): attacker-influenced strings
 * (`matched_attack`, `reasons`, `resource`, and the Phase-5 `source` /
 * `agent_label` headers) are persisted via PARAMETERIZED prepared statements (no
 * string-built SQL); the dashboard owns render-time escaping (Plan 03 threat model).
 *
 * Convention (mirrors ledger.ts / wallet.ts / dedup.ts): the db path is a PARAMETER,
 * never `process.env` inside the module — one DB file, all stores opened once at boot.
 */

import Database from "better-sqlite3";

/**
 * One audit row, as written by `forward.ts` on every decision.
 *
 * Money fields are atomic-unit TEXT (never a number). `injection_detected` is the
 * INTEGER 0/1 form of the verdict's advisory boolean. `control` / `matched_attack` /
 * `protected_atomic` / `settlement_tx` are nullable: a block names a `control` and
 * sets `protected_atomic` with `settlement_tx` NULL; an allow that settles carries
 * the real `settlement_tx` (or NULL in stub mode) with no `control`.
 *
 * `source` / `agent_label` (Phase 5, D-06/D-07): the external agent's un-spoofable
 * edge client IP (`CF-Connecting-IP`) and an OPTIONAL self-label (`X-Sentinel-Agent`),
 * both nullable. Rows that pre-date the migration read NULL for both.
 */
export interface AuditRow {
  /** Epoch ms when the decision was made (`Date.now()`). */
  decided_at: number;
  /** The verdict decision: `allow` | `block` | `step-up`. */
  decision: string;
  /** The named deterministic control that produced a block, or null on an allow. */
  control: string | null;
  /** The advisory named attack class the judge matched, or null. */
  matched_attack: string | null;
  /** The judge's advisory injection flag as INTEGER 0/1. */
  injection_detected: number;
  /** JSON-stringified `reasons[]` from the verdict. */
  reasons: string | null;
  /** The payment amount in atomic units, as exact TEXT (never a float). */
  amount_atomic: string | null;
  /** The atomic-unit amount protected by a block, as exact TEXT, or null on an allow. */
  protected_atomic: string | null;
  /** The decoded upstream host the agent was paying. */
  target_host: string | null;
  /** The x402 resource path. */
  resource: string | null;
  /** The real Arc-testnet settlement tx hash on a settled allow; NULL on a block/step-up or a stub allow. */
  settlement_tx: string | null;
  /** The external agent's edge client IP (`CF-Connecting-IP`); null if absent / pre-migration (D-06). */
  source: string | null;
  /** The optional `X-Sentinel-Agent` self-label (clamped upstream to 64 chars); null if absent (D-07). */
  agent_label: string | null;
}

/** A persisted audit row, as read back (carries the autoincrement `id`). */
export interface AuditRecord extends AuditRow {
  id: number;
}

/** Aggregate headline metrics for the dashboard (OBS-02/03). */
export interface AuditMetrics {
  /** Payments screened = COUNT(*) of all decisions. */
  screened: number;
  /** Attacks blocked = COUNT WHERE decision != 'allow' (blocks + step-ups). */
  blocked: number;
  /** USDC protected = BigInt SUM of protected_atomic over non-allow rows, as a string. */
  protectedAtomic: string;
}

/**
 * One attacks-blocked-by-type bucket (OBS-03), grouped on `matched_attack`.
 * Byte-identical to the dashboard's `dashboard/lib/queries.ts` AttackBucket shape.
 */
export interface AttackBucket {
  /** The matched-attack class, or "unknown" when null (a deterministic-only block). */
  matched_attack: string;
  /** How many blocked rows carry this class. */
  count: number;
}

/** A handle over the append-only `audit` table in one SQLite file. */
export interface Audit {
  /** Append ONE decision row (INSERT-only; called once per decision in forward.ts). */
  insert(row: AuditRow): void;
  /** Most-recent decisions first, capped at `limit` (the dashboard live feed). */
  recentFeed(limit: number): AuditRecord[];
  /** A single decision by id (the dashboard drill-down), or undefined if absent. */
  byId(id: number): AuditRecord | undefined;
  /** The three headline metrics; `protectedAtomic` summed in JS BigInt, never float. */
  metrics(): AuditMetrics;
  /**
   * Blocked rows grouped by `COALESCE(matched_attack,'unknown')`, ordered by count
   * desc — byte-identical to `dashboard/lib/queries.ts` getAttacksByType (OBS-03).
   */
  attacksByType(): AttackBucket[];
  /**
   * Distinct external agents (D-07): `COUNT(DISTINCT source)` over non-null sources,
   * EXCLUDING rows whose `source` equals `devSource`. Pass `devSource = null` (or "")
   * to count all non-null sources (no exclusion). This is the honest N>1 metric.
   */
  distinctAgents(devSource: string | null): number;
}

/**
 * Open (or create) the append-only audit log at `dbPath`.
 *
 * @param dbPath SQLite file path, or `":memory:"` for a per-connection ephemeral db.
 */
export function openAudit(dbPath: string): Audit {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
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
      ")",
  );

  // Phase-5 additive migration (D-06/D-07, RESEARCH Pattern 4). `ALTER TABLE ADD
  // COLUMN` with no default is ADDITIVE schema DDL — it is NOT a row UPDATE/DELETE,
  // so the append-only-by-code-shape invariant (T-04-06 / T-05-04) holds and stays
  // grep-verifiable. Idempotent: a PRAGMA table_info guard means re-opening a db that
  // already has the columns is a no-op, and a db that pre-dates the migration gains
  // them with old rows reading NULL (SQLite default for a no-default added column).
  ensureColumn(db, "audit", "source", "TEXT");
  ensureColumn(db, "audit", "agent_label", "TEXT");

  // The ONLY write statement against `audit` — insert-only. No row-mutating or
  // row-removing statement exists anywhere in this module (append-only by code
  // shape, D-03 / T-04-06).
  // Parameterized: attacker-influenced strings are bound as DATA, never built into SQL.
  const insertStmt = db.prepare(
    "INSERT INTO audit (" +
      "decided_at, decision, control, matched_attack, injection_detected, reasons, " +
      "amount_atomic, protected_atomic, target_host, resource, settlement_tx, " +
      "source, agent_label" +
      ") VALUES (" +
      "@decided_at, @decision, @control, @matched_attack, @injection_detected, @reasons, " +
      "@amount_atomic, @protected_atomic, @target_host, @resource, @settlement_tx, " +
      "@source, @agent_label" +
      ")",
  );

  // Read statements the dashboard (Plan 03) consumes behind this same typed interface.
  const recentStmt = db.prepare(
    "SELECT * FROM audit ORDER BY id DESC LIMIT ?",
  );
  const byIdStmt = db.prepare("SELECT * FROM audit WHERE id = ?");
  // For the protected SUM we SELECT the TEXT values and fold them in BigInt below —
  // NEVER SQLite's float SUM() (mirrors ledger.spentSince, money math stays exact).
  const protectedStmt = db.prepare(
    "SELECT protected_atomic FROM audit WHERE decision != 'allow' AND protected_atomic IS NOT NULL",
  );
  const screenedStmt = db.prepare("SELECT COUNT(*) AS n FROM audit");
  const blockedStmt = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE decision != 'allow'");
  // OBS-03 attacks-by-type — byte-identical to dashboard/lib/queries.ts getAttacksByType.
  const byTypeStmt = db.prepare(
    "SELECT COALESCE(matched_attack, 'unknown') AS matched_attack, COUNT(*) AS count " +
      "FROM audit WHERE decision != 'allow' " +
      "GROUP BY COALESCE(matched_attack, 'unknown') ORDER BY count DESC",
  );
  // D-07 honest distinct-agent count: distinct non-null sources, excluding the dev's
  // own source. `@devSource IS NULL OR source != @devSource` makes a null/empty
  // devSource count ALL non-null sources (no exclusion).
  const distinctAgentsStmt = db.prepare(
    "SELECT COUNT(DISTINCT source) AS n FROM audit " +
      "WHERE source IS NOT NULL AND (@devSource IS NULL OR source != @devSource)",
  );

  function insert(row: AuditRow): void {
    insertStmt.run(row);
  }

  function recentFeed(limit: number): AuditRecord[] {
    return recentStmt.all(limit) as AuditRecord[];
  }

  function byId(id: number): AuditRecord | undefined {
    return byIdStmt.get(id) as AuditRecord | undefined;
  }

  function metrics(): AuditMetrics {
    const screened = (screenedStmt.get() as { n: number }).n;
    const blocked = (blockedStmt.get() as { n: number }).n;
    // Sum in BigInt, never SQLite's float SUM() — the headline USDC-protected number
    // stays exact for any number of tiny blocks (mirrors ledger.spentSince).
    const rows = protectedStmt.all() as Array<{ protected_atomic: string }>;
    let total = 0n;
    for (const r of rows) total += BigInt(r.protected_atomic);
    return { screened, blocked, protectedAtomic: total.toString() };
  }

  function attacksByType(): AttackBucket[] {
    return byTypeStmt.all() as AttackBucket[];
  }

  function distinctAgents(devSource: string | null): number {
    // Normalize "" to null so an unset SENTINEL_DEV_SOURCE excludes nothing.
    const dev = devSource && devSource.length > 0 ? devSource : null;
    return (distinctAgentsStmt.get({ devSource: dev }) as { n: number }).n;
  }

  return { insert, recentFeed, byId, metrics, attacksByType, distinctAgents };
}

/**
 * Add a column to `table` if it is not already present (idempotent additive DDL).
 *
 * Uses `PRAGMA table_info` to check, then `ALTER TABLE ... ADD COLUMN`. Additive DDL
 * only — never a row mutation — so the append-only-by-code-shape invariant holds
 * (D-07, T-05-04). The column name + declaration are module-internal literals, never
 * attacker input (no injection surface).
 */
function ensureColumn(
  db: Database.Database,
  table: string,
  col: string,
  decl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}

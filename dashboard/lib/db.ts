/**
 * Server-only READ boundary for the dashboard's data (DIST-02, D-03).
 *
 * Phase 5 re-points the dashboard's reads from a shared SQLite file to HTTP fetches
 * against the proxy's live JSON read endpoints over the Cloudflare tunnel (Plan 01). The
 * proxy is the SOLE owner of the audit data; the dashboard now reads it across the network
 * via `./api-client`, which reads the `SENTINEL_API_BASE_URL` tunnel base. The former native
 * SQLite open + the shared-db-path file are gone (no native addon in the Vercel build —
 * RESEARCH Pattern 2.2).
 *
 * `import "server-only"` (threat T-05-08): the tunnel base URL is a PLAIN server env var
 * (`SENTINEL_API_BASE_URL`, NOT `NEXT_PUBLIC_`). Keeping the server-only guard means the
 * base URL is read only on the server (route handlers / server components) and never ships
 * to the client bundle. Route handlers that consume this set `export const runtime = "nodejs"`.
 *
 * The four exported READ functions keep the SAME names as the Phase 4 contract
 * (`getMetrics` / `getFeed` / `getVerdict` / `getAttacksByType`) and delegate 1:1 to
 * `./api-client`; they are now async (a network read cannot be synchronous), so the route
 * handlers await them. The `AuditRecord` / `DashboardMetrics` / `AttackBucket` types are
 * re-exported (still authored in `./queries`).
 */
import "server-only";
import * as api from "./api-client";

export type {
  AuditRecord,
  DashboardMetrics,
  AttackBucket,
} from "./queries";

/** The headline numbers + by-type + distinctAgents; `protectedAtomic` stays an atomic string. */
export function getMetrics() {
  return api.getMetrics();
}

/** Most-recent decisions first, capped at `limit` — the live verdict feed (OBS-02). */
export function getFeed(limit: number) {
  return api.getFeed(limit);
}

/** A single decision by id — the per-verdict drill-down (OBS-03), or undefined. */
export function getVerdict(id: number) {
  return api.getVerdict(id);
}

/** Attacks-blocked-by-type, grouped on `matched_attack` over blocked rows (OBS-03). */
export function getAttacksByType() {
  return api.getAttacksByType();
}

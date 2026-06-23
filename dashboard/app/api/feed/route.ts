/**
 * GET /api/feed?limit=N — the recent verdict feed, most-recent-first (OBS-02).
 *
 * `runtime = "nodejs"` (native better-sqlite3, no edge — RESEARCH Pitfall 4). READS only.
 * `limit` is clamped to a sane range so a hostile query string can't ask for an unbounded
 * scan. `Cache-Control: no-store` — the feed is live.
 */
import { getFeed } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) limit = Math.min(Math.max(parsed, 1), MAX_LIMIT);
  }
  const feed = await getFeed(limit);
  return Response.json(
    { feed },
    { headers: { "Cache-Control": "no-store" } },
  );
}

"use client";

/**
 * Sentinel canlı güvenlik paneli — the demo surface (OBS-02/03, D-04).
 *
 * `"use client"`: this component NEVER imports `lib/db.ts` (the native better-sqlite3
 * module stays server-only — threat T-04-12/13). It polls the read-only route handlers
 * every ~2s with `setInterval(fetch, 2000)` (D-04 poll, NOT SSE) and renders:
 *   1) three headline cards — payments screened / attacks blocked / USDC protected
 *   2) a live verdict feed (most-recent-first, color-coded allow/block/step-up)
 *   3) a click-to-open per-verdict drill-down (rationale, matched_attack,
 *      injection_detected, settlement tx → arcscan when present)
 *   4) an attacks-blocked-by-type side panel (grouped on matched_attack)
 *
 * STORED-XSS GUARD (threat T-04-11): every attacker-influenced string
 * (`matched_attack`, `reasons`, `resource`, `target_host`) is rendered as React text
 * content — NEVER `dangerouslySetInnerHTML`. React escapes it.
 *
 * MONEY (threat T-04-08): `protectedAtomic` arrives as an atomic-unit STRING. We format
 * it to human USDC via BigInt string math for DISPLAY ONLY — float never re-enters data.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 2000;
const USDC_DECIMALS = 6n;
const ARCSCAN_TX = "https://testnet.arcscan.app/tx/";

interface Metrics {
  screened: number;
  blocked: number;
  protectedAtomic: string;
  byType: Array<{ matched_attack: string; count: number }>;
  /** Distinct external agents (by CF-Connecting-IP), the developer excluded (D-06/D-07). */
  distinctAgents?: number;
}

/**
 * Cross-network read states (D-03). Reads now cross the Cloudflare tunnel, so the page
 * distinguishes: cold (no successful poll yet → tiles show `—`, pill BAĞLANIYOR), live
 * (CANLI), stale (no recent success but no hard error → BAĞLANTI BEKLENİYOR), and error
 * (a fetch rejected / non-OK → BAĞLANTI YOK + banner). On any failure the last good tile
 * values are KEPT — never blanked to 0 (that would misreport traction as a crash).
 */
type ConnState = "cold" | "live" | "stale" | "error";

interface FeedRow {
  id: number;
  decided_at: number;
  decision: string;
  control: string | null;
  matched_attack: string | null;
  injection_detected: number | null;
  amount_atomic: string | null;
  protected_atomic: string | null;
  target_host: string | null;
  resource: string | null;
  settlement_tx: string | null;
}

interface VerdictRow extends FeedRow {
  reasons: string | null;
}

/** Format an atomic-unit USDC string to a human "12.345678" string via BigInt (no float). */
function formatUsdc(atomic: string | null): string {
  if (!atomic) return "0";
  let neg = false;
  let v: bigint;
  try {
    v = BigInt(atomic);
  } catch {
    return "0";
  }
  if (v < 0n) {
    neg = true;
    v = -v;
  }
  const base = 10n ** USDC_DECIMALS;
  const whole = v / base;
  const frac = (v % base).toString().padStart(Number(USDC_DECIMALS), "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${body}` : body;
}

function decisionClass(d: string): string {
  if (d === "allow") return "allow";
  if (d === "step-up") return "stepup";
  return "block";
}

function decisionLabel(d: string): string {
  if (d === "allow") return "İZİN";
  if (d === "step-up") return "EK ONAY";
  return "BLOK";
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString("tr-TR", { hour12: false });
  } catch {
    return String(ms);
  }
}

/**
 * Map a connection state to its inherited `.live-pill` variant + Turkish copy (D-03):
 *   cold  → BAĞLANIYOR (neutral, no pulse — the new `.live-pill.cold` rule)
 *   live  → CANLI (existing `.live-pill` allow color + pulse)
 *   stale → BAĞLANTI BEKLENİYOR (existing `.live-pill.stale`)
 *   error → BAĞLANTI YOK (the new `.live-pill.error` — `--block` colors, no pulse)
 */
function connPill(conn: ConnState): { cls: string; text: string } {
  switch (conn) {
    case "live":
      return { cls: "live-pill", text: "CANLI" };
    case "stale":
      return { cls: "live-pill stale", text: "BAĞLANTI BEKLENİYOR" };
    case "error":
      return { cls: "live-pill error", text: "BAĞLANTI YOK" };
    case "cold":
    default:
      return { cls: "live-pill cold", text: "BAĞLANIYOR" };
  }
}

export default function Page() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<VerdictRow | null>(null);
  const [conn, setConn] = useState<ConnState>("cold");
  const [lastOk, setLastOk] = useState<number | null>(null);
  const lastOkRef = useRef<number>(0);
  // True once at least one poll has SUCCEEDED — gates the cold `—` placeholder so a later
  // failure keeps showing real numbers instead of regressing to the cold em-dash.
  const everOkRef = useRef<boolean>(false);

  const poll = useCallback(async () => {
    try {
      const [mRes, fRes] = await Promise.all([
        fetch("/api/metrics", { cache: "no-store" }),
        fetch("/api/feed?limit=50", { cache: "no-store" }),
      ]);
      // A non-OK status (tunnel/proxy down → 5xx) is a hard error, not a success.
      if (!mRes.ok || !fRes.ok) {
        throw new Error(`read failed: metrics ${mRes.status} feed ${fRes.status}`);
      }
      // Only overwrite tile/feed state on a genuine success — never blank to 0 on failure.
      setMetrics(await mRes.json());
      const data = await fRes.json();
      setFeed(data.feed ?? []);
      const now = Date.now();
      lastOkRef.current = now;
      everOkRef.current = true;
      setLastOk(now);
      setConn("live");
    } catch {
      // Hard failure (reject or non-OK): surface the error pill + banner, but KEEP the last
      // good metrics/feed in state (do not setMetrics/setFeed) so traction is never blanked.
      setConn("error");
    }
  }, []);

  // Poll metrics + feed every ~2s (D-04), with cleanup on unmount.
  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // Decay live → stale if no successful poll in ~3 ticks (but a hard error stays "error"
  // until the next success clears it; cold stays cold until the first success).
  useEffect(() => {
    const t = setInterval(() => {
      setConn((prev) => {
        if (prev === "error" || prev === "cold") return prev;
        return Date.now() - lastOkRef.current > POLL_MS * 3 ? "stale" : prev;
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Fetch the drill-down when a row is selected.
  useEffect(() => {
    if (selectedId == null) {
      setVerdict(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/verdict/${selectedId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setVerdict(data?.verdict ?? null);
      })
      .catch(() => {
        if (!cancelled) setVerdict(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Close the drawer on Escape.
  useEffect(() => {
    if (selectedId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  // Cold load (no successful poll yet) shows `—`, NOT `0`, to distinguish "unknown" from
  // "genuinely zero" (UI-SPEC). Once a poll has ever succeeded, fall back to the last value.
  const cold = !everOkRef.current && metrics == null;
  const screened = cold ? "—" : (metrics?.screened ?? 0).toLocaleString("tr-TR");
  const blocked = cold ? "—" : (metrics?.blocked ?? 0).toLocaleString("tr-TR");
  const protectedUsdc = cold ? "—" : formatUsdc(metrics?.protectedAtomic ?? "0");
  const byType = metrics?.byType ?? [];

  // Distinct external agents (dev-excluded). `null` while unknown (cold) → render `—`.
  const distinctAgents = cold ? null : metrics?.distinctAgents ?? 0;

  const pill = connPill(conn);

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            S
          </div>
          <div>
            <div className="brand-title">Sentinel</div>
            <div className="brand-sub">
              Otonom ödeme yapan ajanlar için canlı güvenlik proxy&apos;si
            </div>
          </div>
        </div>
        <span className={pill.cls}>
          <span className="live-dot" />
          {pill.text}
        </span>
      </div>

      {/* Headline metrics (OBS-02). Cold load shows `—`, never `0` (UI-SPEC). */}
      <div className="metrics metrics--4">
        <div className="card">
          <div className="card-label">Taranan Ödeme</div>
          <div className="card-value">{screened}</div>
          <div className="card-foot">Sentinel&apos;den geçen tüm kararlar</div>
        </div>
        <div className="card blocked">
          <div className="card-label">Bloklanan Saldırı</div>
          <div className="card-value">{blocked}</div>
          <div className="card-foot">Ödeme on-chain&apos;e gitmeden durduruldu</div>
        </div>
        <div className="card protected">
          <div className="card-label">Korunan USDC</div>
          <div className="card-value">{protectedUsdc}</div>
          <div className="card-foot">Bloklanan ödemelerin toplam tutarı</div>
        </div>
        {/*
          Distinct external agents (D-06/D-07) — the honesty axis. NEUTRAL `--text` value
          (no .protected/.blocked modifier, no accent). The dev-exclusion `.card-foot` line
          is MANDATORY (what makes the figure read as honest). Cold → `—`; N=0 → `0` +
          "Henüz dış ajan yok"; N>=1 → count + "{N} dış ajan korunuyor".
        */}
        <div className="card">
          <div className="card-label">KORUNAN AJAN</div>
          <div className="card-value">
            {distinctAgents == null
              ? "—"
              : distinctAgents.toLocaleString("tr-TR")}
          </div>
          <div className="card-foot">
            Geliştirici hariç, benzersiz dış ajan (kaynak IP)
          </div>
          {distinctAgents != null && distinctAgents === 0 && (
            <div className="card-foot card-foot-faint">Henüz dış ajan yok</div>
          )}
          {distinctAgents != null && distinctAgents >= 1 && (
            <div className="card-foot card-foot-faint">
              {distinctAgents.toLocaleString("tr-TR")} dış ajan korunuyor
            </div>
          )}
        </div>
      </div>

      <div className="grid">
        {/* Live verdict feed (OBS-02) */}
        <div className="panel">
          <div className="panel-head">
            Canlı Karar Akışı
            <span className="muted">
              ~2sn yoklama · satıra tıkla → detay
              {lastOk != null && ` · Son güncelleme: ${fmtTime(lastOk)}`}
            </span>
          </div>
          {/*
            Connection error banner (D-03): on a hard fetch failure the pill goes BAĞLANTI
            YOK and this one-line banner appears above the feed; it auto-clears on the next
            successful poll (no close button, no toast). The tiles KEEP their last values.
          */}
          {conn === "error" && (
            <div className="conn-banner">
              Proxy&apos;ye ulaşılamıyor — panel son bilinen veriyi gösteriyor.
              Yeniden deneniyor…
            </div>
          )}
          {cold ? (
            <div className="empty">Panele bağlanılıyor…</div>
          ) : feed.length === 0 ? (
            <div className="empty">
              Henüz karar yok — proxy üzerinden bir ödeme sür.
            </div>
          ) : (
            <table className="feed">
              <thead>
                <tr>
                  <th>Zaman</th>
                  <th>Karar</th>
                  <th>Kontrol / Saldırı</th>
                  <th>Hedef</th>
                  <th>Tutar</th>
                </tr>
              </thead>
              <tbody>
                {feed.map((row) => (
                  <tr
                    key={row.id}
                    className={selectedId === row.id ? "selected" : ""}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <td className="mono">{fmtTime(row.decided_at)}</td>
                    <td>
                      <span className={`badge ${decisionClass(row.decision)}`}>
                        {decisionLabel(row.decision)}
                      </span>
                    </td>
                    <td className="mono">
                      {row.matched_attack ?? row.control ?? "—"}
                    </td>
                    <td className="mono">{row.target_host ?? "—"}</td>
                    <td className="mono">{formatUsdc(row.amount_atomic)} USDC</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Attacks-blocked-by-type (OBS-03) */}
        <div className="panel">
          <div className="panel-head">Saldırı Türüne Göre Blok</div>
          {byType.length === 0 ? (
            <div className="empty">Henüz bloklanan saldırı yok.</div>
          ) : (
            byType.map((b) => (
              <div className="bytype-row" key={b.matched_attack}>
                <span className="bytype-name">{b.matched_attack}</span>
                <span className="bytype-count">{b.count}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Per-verdict drill-down drawer (OBS-03) */}
      {selectedId != null && (
        <>
          <div className="overlay" onClick={() => setSelectedId(null)} />
          <aside className="drawer" role="dialog" aria-label="Karar detayı">
            <div className="drawer-head">
              <h3>Karar #{selectedId}</h3>
              <button
                className="close-btn"
                onClick={() => setSelectedId(null)}
                aria-label="Kapat"
              >
                ×
              </button>
            </div>
            {verdict ? (
              <Drill verdict={verdict} />
            ) : (
              <div className="empty">Yükleniyor…</div>
            )}
          </aside>
        </>
      )}
    </div>
  );
}

/** The drill-down body — all attacker-influenced strings render as escaped React text. */
function Drill({ verdict }: { verdict: VerdictRow }) {
  let reasons: string[] = [];
  if (verdict.reasons) {
    try {
      const parsed = JSON.parse(verdict.reasons);
      if (Array.isArray(parsed)) reasons = parsed.map(String);
    } catch {
      reasons = [verdict.reasons];
    }
  }

  return (
    <div>
      <div className="kv">
        <div className="kv-key">Karar</div>
        <div className="kv-val">
          <span className={`badge ${decisionClass(verdict.decision)}`}>
            {decisionLabel(verdict.decision)}
          </span>
        </div>
      </div>

      <div className="kv">
        <div className="kv-key">Zaman</div>
        <div className="kv-val mono">{fmtTime(verdict.decided_at)}</div>
      </div>

      {verdict.control && (
        <div className="kv">
          <div className="kv-key">Tetikleyen Kontrol</div>
          <div className="kv-val mono">{verdict.control}</div>
        </div>
      )}

      <div className="kv">
        <div className="kv-key">Eşleşen Saldırı</div>
        <div className="kv-val mono">{verdict.matched_attack ?? "—"}</div>
      </div>

      <div className="kv">
        <div className="kv-key">Enjeksiyon Tespiti</div>
        <div className="kv-val">
          <span className={`flag ${verdict.injection_detected ? "on" : "off"}`}>
            {verdict.injection_detected ? "EVET — enjeksiyon yakalandı" : "Hayır"}
          </span>
        </div>
      </div>

      <div className="kv">
        <div className="kv-key">Hedef</div>
        <div className="kv-val mono">
          {verdict.target_host ?? "—"}
          {verdict.resource ? verdict.resource : ""}
        </div>
      </div>

      <div className="kv">
        <div className="kv-key">Tutar</div>
        <div className="kv-val mono">{formatUsdc(verdict.amount_atomic)} USDC</div>
      </div>

      {verdict.protected_atomic && (
        <div className="kv">
          <div className="kv-key">Korunan Tutar</div>
          <div className="kv-val mono">
            {formatUsdc(verdict.protected_atomic)} USDC
          </div>
        </div>
      )}

      <div className="kv">
        <div className="kv-key">Settlement Tx</div>
        <div className="kv-val">
          {verdict.settlement_tx ? (
            <a
              className="tx-link"
              href={`${ARCSCAN_TX}${encodeURIComponent(verdict.settlement_tx)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {verdict.settlement_tx}
            </a>
          ) : (
            <span className="kv-val mono" style={{ color: "var(--text-faint)" }}>
              settle edilmedi (ödeme on-chain&apos;e gitmedi)
            </span>
          )}
        </div>
      </div>

      {reasons.length > 0 && (
        <div className="kv">
          <div className="kv-key">Gerekçe</div>
          <ul className="reasons">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

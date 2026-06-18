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
}

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

export default function Page() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<VerdictRow | null>(null);
  const [live, setLive] = useState(false);
  const lastOkRef = useRef<number>(0);

  const poll = useCallback(async () => {
    try {
      const [mRes, fRes] = await Promise.all([
        fetch("/api/metrics", { cache: "no-store" }),
        fetch("/api/feed?limit=50", { cache: "no-store" }),
      ]);
      if (mRes.ok) setMetrics(await mRes.json());
      if (fRes.ok) {
        const data = await fRes.json();
        setFeed(data.feed ?? []);
      }
      lastOkRef.current = Date.now();
      setLive(true);
    } catch {
      // A transient fetch failure just means the next tick retries; mark stale.
      setLive(false);
    }
  }, []);

  // Poll metrics + feed every ~2s (D-04), with cleanup on unmount.
  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // Mark the live pill stale if no successful poll in ~3 ticks.
  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() - lastOkRef.current > POLL_MS * 3) setLive(false);
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

  const screened = metrics?.screened ?? 0;
  const blocked = metrics?.blocked ?? 0;
  const protectedUsdc = formatUsdc(metrics?.protectedAtomic ?? "0");
  const byType = metrics?.byType ?? [];

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
        <span className={`live-pill${live ? "" : " stale"}`}>
          <span className="live-dot" />
          {live ? "CANLI" : "BAĞLANTI BEKLENİYOR"}
        </span>
      </div>

      {/* Headline metrics (OBS-02) */}
      <div className="metrics">
        <div className="card">
          <div className="card-label">Taranan Ödeme</div>
          <div className="card-value">{screened.toLocaleString("tr-TR")}</div>
          <div className="card-foot">Sentinel&apos;den geçen tüm kararlar</div>
        </div>
        <div className="card blocked">
          <div className="card-label">Bloklanan Saldırı</div>
          <div className="card-value">{blocked.toLocaleString("tr-TR")}</div>
          <div className="card-foot">Ödeme on-chain&apos;e gitmeden durduruldu</div>
        </div>
        <div className="card protected">
          <div className="card-label">Korunan USDC</div>
          <div className="card-value">{protectedUsdc}</div>
          <div className="card-foot">Bloklanan ödemelerin toplam tutarı</div>
        </div>
      </div>

      <div className="grid">
        {/* Live verdict feed (OBS-02) */}
        <div className="panel">
          <div className="panel-head">
            Canlı Karar Akışı
            <span className="muted">~2sn yoklama · satıra tıkla → detay</span>
          </div>
          {feed.length === 0 ? (
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

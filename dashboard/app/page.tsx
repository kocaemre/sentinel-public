"use client";

/**
 * Sentinel live security dashboard — the demo surface (OBS-02/03, D-04).
 *
 * VISUAL CONTRACT: imported from the Claude Design "Sentinel.dc.html" (IBM Plex type,
 * dark/light theme tokens in globals.css, token-driven inline styles, pulse status dot,
 * cumulative-USDC area chart, attack-type bars, click-to-expand decision detail).
 *
 * DATA: the design's simulated random feed is NOT used. Every number is the REAL audit
 * stream — polled from the read-only route handlers every ~2s (D-04 poll, NOT SSE):
 *   /api/metrics → screened / blocked / USDC protected / distinct external agents / byType
 *   /api/feed    → the live decision rows
 *   /api/verdict/:id → the per-decision rationale on expand
 *
 * STORED-XSS GUARD (T-04-11): every attacker-influenced string (matched_attack, reasons,
 * resource, target_host, source, agent_label) renders as React text — never
 * dangerouslySetInnerHTML. MONEY (T-04-08): protectedAtomic/amount_atomic arrive as
 * atomic-unit STRINGs; BigInt formatting for DISPLAY only — float never re-enters data.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 2000;
const USDC_DECIMALS = 6n;
const ARCSCAN_TX = "https://testnet.arcscan.app/tx/";
const SERIES_CAP = 60;

interface Metrics {
  screened: number;
  blocked: number;
  protectedAtomic: string;
  byType: Array<{ matched_attack: string; count: number }>;
  /** Distinct external agents (by CF-Connecting-IP), the developer excluded (D-06/D-07). */
  distinctAgents?: number;
}

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
  source?: string | null;
  agent_label?: string | null;
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

/** atomic USDC string → number of whole USDC, for the chart/headline DISPLAY only. */
function usdcNumber(atomic: string | null): number {
  if (!atomic) return 0;
  try {
    return Number(BigInt(atomic)) / 1_000_000;
  } catch {
    return 0;
  }
}

function fmtUsdMoney(n: number): string {
  return (
    "$" +
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function decisionLabel(d: string): string {
  if (d === "allow") return "ALLOWED";
  if (d === "step-up") return "STEP-UP";
  return "BLOCKED";
}

/** Decision → display colors (token-driven). */
function decisionColors(d: string): { color: string; bg: string } {
  if (d === "allow") return { color: "var(--good)", bg: "var(--good-soft)" };
  if (d === "step-up") return { color: "var(--warn)", bg: "rgba(251,191,36,.13)" };
  return { color: "var(--bad)", bg: "var(--bad-soft)" };
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
  } catch {
    return String(ms);
  }
}

/**
 * Map a real audit attack/control key to a human label + accent color. Unknown keys
 * are prettified (snake_case → Title Case) and shown in neutral grey — nothing is hidden
 * or relabeled into something it isn't (the honesty discipline).
 */
function attackMeta(key: string): { label: string; color: string } {
  switch (key) {
    case "prompt_injection_payment":
      return { label: "Prompt Injection", color: "#fb7185" };
    case "replay":
      return { label: "Replay", color: "#a78bfa" };
    case "per_call_cap":
      return { label: "Per-Call Cap", color: "#3b82f6" };
    case "overpayment_drain":
    case "overpayment":
      return { label: "Overpayment", color: "#fbbf24" };
    case "velocity":
      return { label: "Velocity", color: "#2dd4bf" };
    case "denied":
    case "denied_counterparty":
      return { label: "Denied Counterparty", color: "#f472b6" };
    case "hourly_budget":
    case "daily_budget":
    case "budget":
      return { label: "Budget", color: "#f59e0b" };
    case "unknown":
      return { label: "Unknown", color: "#94a3b8" };
    case "none":
    case "":
      return { label: "Unclassified", color: "#94a3b8" };
    default:
      return {
        label: key
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        color: "#94a3b8",
      };
  }
}

/** Map a connection state to its status pill: text, color, and whether the dot pulses. */
function connPill(conn: ConnState): { text: string; color: string; pulse: boolean } {
  switch (conn) {
    case "live":
      return { text: "LIVE", color: "var(--good)", pulse: true };
    case "stale":
      return { text: "RECONNECTING", color: "var(--warn)", pulse: false };
    case "error":
      return { text: "OFFLINE", color: "var(--bad)", pulse: false };
    case "cold":
    default:
      return { text: "CONNECTING", color: "var(--muted)", pulse: false };
  }
}

export default function Page() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [series, setSeries] = useState<number[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<VerdictRow | null>(null);
  const [conn, setConn] = useState<ConnState>("cold");
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const lastOkRef = useRef<number>(0);
  const everOkRef = useRef<boolean>(false);

  const poll = useCallback(async () => {
    try {
      const [mRes, fRes] = await Promise.all([
        fetch("/api/metrics", { cache: "no-store" }),
        fetch("/api/feed?limit=50", { cache: "no-store" }),
      ]);
      if (!mRes.ok || !fRes.ok) {
        throw new Error(`read failed: metrics ${mRes.status} feed ${fRes.status}`);
      }
      const m: Metrics = await mRes.json();
      setMetrics(m);
      const data = await fRes.json();
      setFeed(data.feed ?? []);
      // Accumulate the cumulative-USDC-protected series client-side (we sample the real
      // running total on each successful poll — honest, monotonic, capped).
      setSeries((prev) => [...prev, usdcNumber(m.protectedAtomic)].slice(-SERIES_CAP));
      const now = Date.now();
      lastOkRef.current = now;
      everOkRef.current = true;
      setLastOk(now);
      setConn("live");
    } catch {
      setConn("error");
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  useEffect(() => {
    const t = setInterval(() => {
      setConn((prev) => {
        if (prev === "error" || prev === "cold") return prev;
        return Date.now() - lastOkRef.current > POLL_MS * 3 ? "stale" : prev;
      });
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  // Reflect the theme on <html> so the [data-theme] token set re-skins everything.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Fetch the drill-down rationale when a row is selected.
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

  const cold = !everOkRef.current && metrics == null;
  const screened = cold ? "—" : (metrics?.screened ?? 0).toLocaleString("en-US");
  const blocked = cold ? "—" : (metrics?.blocked ?? 0).toLocaleString("en-US");
  const usdcVal = usdcNumber(metrics?.protectedAtomic ?? "0");
  const protectedUsdc = cold ? "—" : fmtUsdMoney(usdcVal);
  const byType = metrics?.byType ?? [];
  const distinctAgents = cold ? null : metrics?.distinctAgents ?? 0;

  const pill = connPill(conn);

  // Stat cards (token-driven dots/values).
  const stats = [
    {
      label: "Payments Screened",
      value: screened,
      caption: "All decisions through Sentinel",
      color: "var(--text)",
      dot: "var(--accent)",
    },
    {
      label: "Attacks Blocked",
      value: blocked,
      caption: "Stopped before settling on-chain",
      color: "var(--bad)",
      dot: "var(--bad)",
    },
    {
      label: "USDC Protected",
      value: protectedUsdc,
      caption: "Value of blocked payments",
      color: "var(--accent)",
      dot: "var(--accent)",
    },
    {
      label: "Protected Agents",
      value: distinctAgents == null ? "—" : distinctAgents.toLocaleString("en-US"),
      caption: "Distinct external agents · developer excluded",
      color: "var(--text)",
      dot: "var(--good)",
    },
  ];

  // Attacks-by-type bars (real counts → pct of the max).
  const attackBars = byType.map((b) => {
    const meta = attackMeta(b.matched_attack);
    return { key: b.matched_attack, label: meta.label, color: meta.color, count: b.count };
  });
  const maxCount = Math.max(1, ...attackBars.map((a) => a.count));

  // Cumulative-USDC area/line path (matches the design's 100×40 viewBox).
  const W = 100;
  const H = 40;
  const ser = series.length > 1 ? series : [usdcVal, usdcVal];
  const max = Math.max(...ser);
  const min = Math.min(...ser);
  const span = max - min || 1;
  const n = ser.length;
  const X = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
  const Y = (v: number) => H - ((v - min) / span) * (H - 4) - 2;
  let linePath = "";
  ser.forEach((v, i) => {
    linePath += (i ? "L" : "M") + X(i).toFixed(2) + " " + Y(v).toFixed(2) + " ";
  });
  const areaPath =
    "M0 " +
    H +
    " " +
    ser.map((v, i) => "L" + X(i).toFixed(2) + " " + Y(v).toFixed(2)).join(" ") +
    " L" +
    W +
    " " +
    H +
    " Z";

  const agentOf = (r: FeedRow) =>
    r.agent_label || r.source || r.target_host || "—";

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "34px 28px 56px" }}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 26,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "var(--accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontWeight: 700,
                fontSize: 21,
              }}
              aria-hidden
            >
              S
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-.02em" }}>
                Sentinel
              </div>
              <div style={{ fontSize: 13, color: "var(--muted)" }}>
                Live security proxy for autonomous paying agents
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                borderRadius: 999,
                background: "var(--accent-soft)",
                border: "1px solid var(--border)",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: pill.color,
                  animation: pill.pulse ? "pulse 1.6s infinite" : "none",
                }}
              />
              <span
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: ".08em",
                  color: pill.color,
                }}
              >
                {pill.text}
              </span>
            </div>
            <button
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                font: "500 13px 'IBM Plex Sans', system-ui",
                padding: "9px 14px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: "var(--panel)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  display: "inline-block",
                }}
              />
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
          </div>
        </div>

        {/* Stat cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 14,
            marginBottom: 14,
          }}
        >
          {stats.map((st) => (
            <div
              key={st.label}
              style={{
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                padding: 20,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 16 }}>
                <span
                  style={{ width: 7, height: 7, borderRadius: "50%", background: st.dot }}
                />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                    color: "var(--muted)",
                  }}
                >
                  {st.label}
                </span>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 33,
                  fontWeight: 600,
                  letterSpacing: "-.02em",
                  color: st.color,
                }}
              >
                {st.value}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 9 }}>
                {st.caption}
              </div>
            </div>
          ))}
        </div>

        {/* Chart + attacks-by-type */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
          <div
            style={{
              flex: 2,
              minWidth: 360,
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 14,
              padding: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>USDC protected · cumulative</div>
              <div className="mono" style={{ fontSize: 13, color: "var(--accent)" }}>
                {cold ? "—" : fmtUsdMoney(usdcVal)}
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 12px" }}>
              Value of payments stopped before settling on-chain
            </div>
            <svg
              viewBox="0 0 100 40"
              preserveAspectRatio="none"
              style={{ width: "100%", height: 170, display: "block" }}
            >
              <path d={areaPath} fill="var(--accent)" fillOpacity={0.12} />
              <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={0.7} />
            </svg>
          </div>

          <div
            style={{
              flex: 1,
              minWidth: 280,
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 14,
              padding: 20,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 18 }}>
              Blocks by attack type
            </div>
            {attackBars.length === 0 ? (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--muted)",
                  padding: "24px 0",
                  textAlign: "center",
                }}
              >
                No attacks blocked yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {attackBars.map((a) => (
                  <div key={a.key}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12.5,
                        marginBottom: 6,
                      }}
                    >
                      <span>{a.label}</span>
                      <span className="mono" style={{ color: "var(--muted)" }}>
                        {a.count}
                      </span>
                    </div>
                    <div
                      style={{
                        height: 7,
                        borderRadius: 4,
                        background: "var(--grid)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          borderRadius: 4,
                          width: `${Math.round((a.count / maxCount) * 100)}%`,
                          background: a.color,
                          transition: "width .4s ease",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Live decision feed */}
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              padding: "16px 20px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Live decision feed</span>
              <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 8 }}>
                ~2s polling · click a row for details
              </span>
            </div>
            <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
              updated {lastOk != null ? fmtTime(lastOk) : "—"}
            </span>
          </div>

          {conn === "error" && (
            <div
              style={{
                padding: "10px 20px",
                fontSize: 12.5,
                color: "var(--bad)",
                background: "var(--bad-soft)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              Can&apos;t reach the proxy — showing last known data. Retrying…
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 620 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "90px 1fr 130px 120px 1fr",
                  padding: "10px 20px",
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: ".05em",
                  textTransform: "uppercase",
                  color: "var(--muted)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span>Time</span>
                <span>Agent</span>
                <span style={{ textAlign: "right" }}>Amount</span>
                <span style={{ textAlign: "center" }}>Decision</span>
                <span style={{ textAlign: "right" }}>Attack type</span>
              </div>

              {cold ? (
                <div style={{ padding: 34, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                  Connecting to the secure stream…
                </div>
              ) : feed.length === 0 ? (
                <div style={{ padding: 34, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                  No decisions yet — drive a payment through the proxy.
                </div>
              ) : (
                feed.slice(0, 12).map((r) => {
                  const dc = decisionColors(r.decision);
                  const atkKey = r.matched_attack ?? r.control;
                  const atk = atkKey ? attackMeta(atkKey) : null;
                  return (
                    <div
                      key={r.id}
                      onClick={() => setSelectedId(selectedId === r.id ? null : r.id)}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "90px 1fr 130px 120px 1fr",
                        alignItems: "center",
                        padding: "12px 20px",
                        fontSize: 13,
                        borderBottom: "1px solid var(--border)",
                        cursor: "pointer",
                        background:
                          r.id === selectedId ? "var(--accent-soft)" : "transparent",
                      }}
                    >
                      <span className="mono" style={{ color: "var(--muted)" }}>
                        {fmtTime(r.decided_at)}
                      </span>
                      <span className="mono">{agentOf(r)}</span>
                      <span
                        className="mono"
                        style={{ textAlign: "right" }}
                      >
                        {formatUsdc(r.amount_atomic)} USDC
                      </span>
                      <span style={{ textAlign: "center" }}>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            fontWeight: 600,
                            padding: "3px 9px",
                            borderRadius: 5,
                            color: dc.color,
                            background: dc.bg,
                          }}
                        >
                          {decisionLabel(r.decision)}
                        </span>
                      </span>
                      <span style={{ textAlign: "right", color: atk ? atk.color : "var(--muted)" }}>
                        {atk ? atk.label : "—"}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Expanded decision detail (real verdict — rationale, injection, settlement tx) */}
          {selectedId != null && (
            <DetailPanel
              id={selectedId}
              verdict={verdict}
              row={feed.find((f) => f.id === selectedId) ?? null}
              agentOf={agentOf}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The expanded decision detail — design-style inline panel, enriched with real fields. */
function DetailPanel({
  id,
  verdict,
  row,
  agentOf,
}: {
  id: number;
  verdict: VerdictRow | null;
  row: FeedRow | null;
  agentOf: (r: FeedRow) => string;
}) {
  const src = verdict ?? row;
  if (!src) {
    return (
      <div style={{ padding: "18px 20px", borderTop: "1px solid var(--border)", background: "var(--panel2)", color: "var(--muted)", fontSize: 13 }}>
        Loading decision #{id}…
      </div>
    );
  }
  const dc = decisionColors(src.decision);
  const atkKey = src.matched_attack ?? src.control;
  const atk = atkKey ? attackMeta(atkKey) : null;

  let reasons: string[] = [];
  if (verdict?.reasons) {
    try {
      const parsed = JSON.parse(verdict.reasons);
      if (Array.isArray(parsed)) reasons = parsed.map(String);
      else reasons = [verdict.reasons];
    } catch {
      reasons = [verdict.reasons];
    }
  }

  const cell = (key: string, val: React.ReactNode, valColor?: string) => (
    <div>
      <div style={{ color: "var(--muted)", fontSize: 11, marginBottom: 4 }}>{key}</div>
      <div
        className="mono"
        style={{ color: valColor ?? "var(--text)", wordBreak: "break-all" }}
      >
        {val}
      </div>
    </div>
  );

  return (
    <div style={{ padding: "18px 20px", borderTop: "1px solid var(--border)", background: "var(--panel2)" }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: ".06em",
          color: "var(--muted)",
          marginBottom: 12,
        }}
      >
        Decision detail · #{id}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 16,
          fontSize: 13,
        }}
      >
        {cell("Agent", agentOf(src))}
        {cell("Amount", `${formatUsdc(src.amount_atomic)} USDC`)}
        {cell(
          "Decision",
          <span style={{ color: dc.color, fontWeight: 600 }}>{decisionLabel(src.decision)}</span>,
        )}
        {cell("Attack type", atk ? atk.label : "—", atk ? atk.color : "var(--muted)")}
        {cell(
          "Injection detected",
          src.injection_detected ? "YES — injection caught" : "No",
          src.injection_detected ? "var(--bad)" : "var(--muted)",
        )}
        {cell(
          "Target",
          `${src.target_host ?? "—"}${src.resource ?? ""}`,
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ color: "var(--muted)", fontSize: 11, marginBottom: 4 }}>Settlement tx</div>
        {src.settlement_tx ? (
          <a
            className="mono"
            href={`${ARCSCAN_TX}${encodeURIComponent(src.settlement_tx)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--accent)", fontSize: 12.5, wordBreak: "break-all" }}
          >
            {src.settlement_tx}
          </a>
        ) : (
          <span className="mono" style={{ color: "var(--muted)", fontSize: 12.5 }}>
            not settled — the payment never went on-chain
          </span>
        )}
      </div>

      {reasons.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: "var(--muted)", fontSize: 11, marginBottom: 6 }}>Rationale</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55 }}>
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

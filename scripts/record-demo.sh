#!/usr/bin/env bash
#
# record-demo.sh — the deterministic driver for the <3-minute killer-demo video
# (DEMO-04, D-08). It wraps the proven Phase 3 contrast (reference-agent/src/demo.ts:
# LEGIT /paid ALLOWED vs INJECTED /paid-injected BLOCKED) and adds the two things a
# recordable run needs:
#
#   1. a FRESH SENTINEL_DB_PATH per run, so a previously-settled (paymentId, resource)
#      never replay-blocks the legit /paid contrast (POLICY-06 is correct behavior, not
#      a defect — but it must not silently break the recording).
#   2. real Arc-testnet settlement by default (so the legit allow produces a REAL tx
#      hash visible in the dashboard drill-down), with a one-flag `--stub` STANDBY so the
#      recording still completes if testnet / faucet flakes.
#
# It adds NO logic to the decision path — it only boots the mock upstream + proxy with
# the right env and runs the existing demo CLI. Secrets are read from the environment
# ONLY (never embedded here): SENTINEL_WALLET_PRIVATE_KEY (real mode) and
# OPENROUTER_API_KEY (the live judge).
#
# Usage:
#   bash scripts/record-demo.sh          # real Arc settlement (needs a funded wallet key)
#   bash scripts/record-demo.sh --stub   # deterministic stub standby (no chain, no key)
#
set -euo pipefail

# ── resolve repo root (this script lives in <root>/scripts) ───────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── settlement mode: real by default, --stub for the standby ──────────────────
MODE="real"
for arg in "$@"; do
  case "$arg" in
    --stub) MODE="stub" ;;
    --real) MODE="real" ;;
    *) echo "unknown arg: $arg (use --stub or --real)" >&2; exit 2 ;;
  esac
done
export SENTINEL_SETTLEMENT_MODE="$MODE"

# ── fresh DB per run so the legit /paid never replay-blocks (D-08) ────────────
DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sentinel-demo.XXXXXX")"
export SENTINEL_DB_PATH="$DB_DIR/sentinel-wallet.db"

# ── local demo wiring (mock upstream on loopback → allow internal) ────────────
MOCK_PORT="${MOCK_PORT:-4021}"
PROXY_PORT="${SENTINEL_PORT:-8787}"
export SENTINEL_PORT="$PROXY_PORT"
export SENTINEL_ALLOWLIST="${SENTINEL_ALLOWLIST:-localhost:$MOCK_PORT}"
export SENTINEL_ALLOW_INTERNAL="${SENTINEL_ALLOW_INTERNAL:-true}"
export SENTINEL_BASE="http://localhost:$PROXY_PORT"
export UPSTREAM_BASE="http://localhost:$MOCK_PORT"

# ── preflight: real mode needs a wallet key; the live judge needs the OR key ──
if [ "$MODE" = "real" ] && [ -z "${SENTINEL_WALLET_PRIVATE_KEY:-}" ]; then
  echo "⚠️  real mode requested but SENTINEL_WALLET_PRIVATE_KEY is unset — the proxy will"
  echo "    fall back to stub for settlement. Export a funded reserve wallet key, or run"
  echo "    with --stub for the deterministic standby."
fi
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "⚠️  OPENROUTER_API_KEY is unset — the injection block will be fail-closed, NOT a"
  echo "    genuine judge catch. Export the key to record the real judge decision."
fi

echo "============================================================"
echo " Sentinel killer demo"
echo "   settlement mode : $SENTINEL_SETTLEMENT_MODE"
echo "   fresh DB        : $SENTINEL_DB_PATH"
echo "   proxy           : $SENTINEL_BASE"
echo "   mock upstream   : $UPSTREAM_BASE"
echo "============================================================"

# ── boot mock upstream + proxy; clean up both on exit ─────────────────────────
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$DB_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for() { # wait_for <url> <name>
  for _ in $(seq 1 50); do
    if curl -fsS -o /dev/null "$1" 2>/dev/null; then return 0; fi
    sleep 0.3
  done
  echo "✗ $2 did not come up at $1" >&2
  return 1
}

echo; echo "[1/3] starting mock x402 upstream …"
pnpm -s -F attack-server start >/dev/null 2>&1 &
PIDS+=("$!")
wait_for "http://localhost:$MOCK_PORT/data" "mock upstream"

echo "[2/3] starting Sentinel proxy …"
pnpm -s -F sentinel-proxy start >/dev/null 2>&1 &
PIDS+=("$!")
wait_for "http://localhost:$PROXY_PORT/api/metrics" "proxy"

echo "[3/3] driving the contrast (LEGIT allowed vs INJECTED blocked) …"
echo
pnpm -s -F reference-agent exec tsx src/demo.ts

echo
echo "============================================================"
echo " done — open the dashboard drill-down to show the tx hash"
echo " (real mode) and the live distinct-agents counter."
echo "============================================================"

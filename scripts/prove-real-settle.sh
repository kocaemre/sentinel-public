#!/usr/bin/env bash
#
# prove-real-settle.sh — one-command proof that a REAL per-payment settlement goes
# through Circle's Arc-testnet Gateway. Stands up a real x402 Gateway-batching seller
# and pays it with the funded+deposited buyer wallet (GatewayClient.pay). Prints the
# Circle transfer the payment created (status "received", real from/to/amount on
# eip155:5042002). Circle Gateway is batched/gasless, so the immediate return is a
# Circle transfer ID rather than an instant 0x hash; the on-chain anchor is the
# one-time deposit tx (proxy/src/settlement/deposit.ts).
#
# Reads the wallet key from proxy/.env (never printed). Usage:
#   bash scripts/prove-real-settle.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f "$ROOT/proxy/.env" ]; then
  echo "proxy/.env not found — it must hold a funded+deposited SENTINEL_WALLET_PRIVATE_KEY." >&2
  exit 1
fi

pnpm -s -F reference-agent exec \
  node --env-file="$ROOT/proxy/.env" --import tsx src/real-settle-test.ts

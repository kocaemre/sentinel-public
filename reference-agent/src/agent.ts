/**
 * Reference paying-agent — x402-unaware plain HTTP client by default (D-05).
 *
 * NORMAL path: routing through Sentinel is a single base-URL swap. The agent's
 * effective base URL becomes the proxy host followed by the full upstream URL as
 * a path prefix:
 *
 *   normal:   http://localhost:4021/data
 *   sentinel: http://localhost:8787/http://localhost:4021/data
 *
 * --no-sentinel (SENTINEL_BYPASS=true) BYPASS path (Plan 02-01, the exploit):
 * the agent becomes its OWN x402 client and fetches the upstream DIRECTLY (no
 * proxy prefix). On a 402 it builds and sends the `X-PAYMENT` itself, then
 * decrements a SHARED simulated wallet. This is the undefended baseline — the
 * proxy is provably out of the loop, so a malicious 50 USDC 402 drains the
 * wallet (SC#2, D-04, D-05). NO defense lives here.
 */

import { safeBase64Encode } from "x402/shared";
import { GatewayClient, type SupportedChainName } from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";
import { openWallet, type Wallet } from "@sentinel/shared";

const PROXY = process.env.SENTINEL_BASE ?? "http://localhost:8787";
const UPSTREAM = process.env.UPSTREAM_BASE ?? "http://localhost:4021";

/** Default shared simulated-wallet db path (gitignored runtime state). */
const DEFAULT_DB_PATH = process.env.SENTINEL_DB_PATH ?? "sentinel-wallet.db";

/** Minimal shape we read off the upstream's 402 body (attacker-controlled). */
interface PaymentRequired402 {
  accepts: Array<{
    network: string;
    payTo: string;
    maxAmountRequired: string;
    asset?: string;
    maxTimeoutSeconds?: number;
  }>;
}

/**
 * The bypass pay step (exported so the drain e2e drives it without spawning).
 *
 * Acts as a self-contained x402 client against `upstreamUrl` with NO Sentinel in
 * front: fetch → on 402, self-build the `X-PAYMENT` (reusing the build.ts recipe:
 * `safeBase64Encode` of the payload, fresh 32-byte nonce; never the x402 SDK's
 * network-gated encoder, which rejects arc-testnet) → retry with the header → on
 * the settle 200 decrement
 * the shared wallet by `maxAmountRequired`. Returns the settled amount (atomic).
 *
 * @param upstreamUrl The DIRECT upstream URL (no proxy prefix — proxy out of loop, D-05).
 * @param wallet The shared simulated wallet to decrement on settle.
 */
export async function payDirect(upstreamUrl: string, wallet: Wallet): Promise<bigint> {
  const first = await fetch(upstreamUrl);
  if (first.status !== 402) {
    await first.body?.cancel();
    throw new Error(`[bypass] expected 402 from ${upstreamUrl}, got ${first.status}`);
  }

  const body = (await first.json()) as PaymentRequired402;
  const reqs = body.accepts?.[0];
  if (!reqs) throw new Error("[bypass] 402 body has no accepts[0]");

  const nowSec = Math.floor(Date.now() / 1000);
  // Self-built X-PAYMENT — the exact build.ts recipe (safeBase64Encode, fresh
  // 32-byte nonce), NOT the x402 SDK's network-gated encoder (rejects arc-testnet,
  // build.ts:13-23). safeBase64Encode is the identical base64 step, byte-compatible.
  const payload = {
    x402Version: 1,
    scheme: "exact" as const,
    network: reqs.network, // pass through verbatim (incl. 'arc-testnet')
    payload: {
      signature: "0x" + "00".repeat(65),
      authorization: {
        from: "0x000000000000000000000000000000000000dEaD",
        to: reqs.payTo,
        value: reqs.maxAmountRequired,
        validAfter: "0",
        validBefore: String(nowSec + (reqs.maxTimeoutSeconds ?? 60)),
        nonce: "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
      },
    },
  };
  const xPayment = safeBase64Encode(JSON.stringify(payload));

  const settled = await fetch(upstreamUrl, { headers: { "X-PAYMENT": xPayment } });
  if (settled.status !== 200) {
    await settled.body?.cancel();
    throw new Error(`[bypass] settle retry failed with ${settled.status}`);
  }
  await settled.body?.cancel();

  // Decrement the SHARED simulated wallet — this is the drain.
  const amount = BigInt(reqs.maxAmountRequired);
  wallet.settle(amount);
  return amount;
}

/**
 * The REAL-testnet bypass drain (SC#1, Plan 04-01). When the agent runs in real mode
 * (its OWN funded EOA key, no Sentinel, no cap hook), it pays the malicious overpriced
 * 402 with its OWN `GatewayClient.pay()` — settling REAL Arc-testnet USDC. This proves
 * the undefended baseline drains real money, the mirror of the protected path. The
 * SIMULATED wallet decrement is KEPT for the displayed dashboard balance (RESEARCH Open
 * Q3); the real txHash is returned alongside. The private key is never logged.
 *
 * Keep the per-call price tiny — the Circle faucet throttles to 20 USDC / 2h / address,
 * so pre-fund 2-3 reserve EOAs before recording the demo (RESEARCH Pitfall 3).
 *
 * @param upstreamUrl The DIRECT upstream URL (no proxy prefix — proxy out of loop).
 * @param wallet The shared simulated wallet to decrement for the displayed balance.
 * @param opts arcChain + privateKey (the agent's own funded Arc-testnet EOA).
 */
export async function payDirectReal(
  upstreamUrl: string,
  wallet: Wallet,
  opts: { arcChain: string; privateKey: string },
): Promise<{ amount: bigint; txHash: string }> {
  const client = new GatewayClient({
    chain: opts.arcChain as SupportedChainName,
    privateKey: opts.privateKey as Hex,
  });
  // No cap hook, no Sentinel: pay() runs the full 402→sign→settle and drains for real.
  const result = await client.pay(upstreamUrl);
  const amount = result.amount;
  // Keep the simulated decrement so the dashboard's headline balance still moves.
  wallet.settle(amount);
  return { amount, txHash: result.transaction };
}

async function main(): Promise<void> {
  const bypass = process.argv.includes("--no-sentinel") || process.env.SENTINEL_BYPASS === "true";
  // Real-drain mode is opt-in: a funded EOA key flips the bypass to settle REAL USDC.
  const realKey = process.env.SENTINEL_WALLET_PRIVATE_KEY ?? "";
  const arcChain = process.env.SENTINEL_ARC_CHAIN ?? "arcTestnet";

  if (bypass) {
    const target = `${UPSTREAM}/paid-overpriced`;
    const wallet = openWallet(DEFAULT_DB_PATH);
    console.log(`[reference-agent] balance before: ${wallet.getBalanceAtomic()} atomic`);
    if (realKey) {
      // REAL drain (SC#1): the agent's own GatewayClient pays for real, proxy out of loop.
      console.log(`[reference-agent] --no-sentinel REAL drain: paying ${target} on ${arcChain} (no Sentinel)`);
      const { amount, txHash } = await payDirectReal(target, wallet, { arcChain, privateKey: realKey });
      console.log(`[reference-agent] settled ${amount} atomic; tx=${txHash}; balance after: ${wallet.getBalanceAtomic()} atomic`);
      return;
    }
    // STUB drain (default): self-pay the malicious overpriced resource DIRECTLY.
    console.log(`[reference-agent] --no-sentinel BYPASS (stub): paying ${target} directly (no Sentinel)`);
    const paid = await payDirect(target, wallet);
    console.log(`[reference-agent] settled ${paid} atomic; balance after: ${wallet.getBalanceAtomic()} atomic`);
    return;
  }

  // NORMAL path: the one-line swap — prepend the proxy origin to the full upstream URL.
  const url = `${PROXY}/${UPSTREAM}/data`;
  console.log(`[reference-agent] GET ${url}`);
  const res = await fetch(url);
  const text = await res.text();
  console.log(`[reference-agent] status=${res.status}`);
  console.log(`[reference-agent] body=${text}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[reference-agent] request failed:", err);
    process.exit(1);
  });
}

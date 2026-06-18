/**
 * Real Arc-testnet settlement via Circle's Gateway (INTEG-01/02/03/04).
 *
 * This MIRRORS `judge/adapter.ts`: a factory that takes a `Pick<Config, ...>`, closes
 * over a LAZILY-constructed single client, returns an async function, and FAILS CLOSED
 * on every error path (`SETTLE_FAILCLOSED`). The two highest-risk facts were probed
 * against the installed `.d.ts` in Task 1 and are wired here verbatim:
 *
 *   - import:  GatewayClient from "@circle-fin/x402-batching/client" (the /client subpath)
 *   - chain:   config.arcChain, default "arcTestnet" (a SupportedChainName; NEVER "arc"/mainnet)
 *   - settle:  PayResult.transaction is the confirmed tx ref; we gate on the
 *              onPaymentResponse hook's ctx.settleResponse?.transaction as the PRIMARY
 *              signal and use PayResult.transaction as a secondary confirm — NEVER on
 *              pay() merely resolving (RESEARCH Pitfall 2 / T-04-04).
 *   - cap:     onBeforePaymentCreation reads ctx.selectedRequirements.amount (string) →
 *              BigInt; abort over perCallCapAtomic OR rolling-hourly budget (D-02/INTEG-03,
 *              an in-process DETERMINISTIC backstop, NOT on-chain).
 *
 * The EOA private key (config.walletPrivateKey) is NEVER logged: the catch logs
 * `(err as Error).message` only, exactly like the judge (T-04-01).
 */

import {
  GatewayClient,
  type SupportedChainName,
  type PayResult,
} from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";
import type { Config } from "../config.js";
import { reqAmountAtomic } from "../policy/amount.js";

/**
 * Structural hook-context shapes (the SDK's hook TYPES are not re-exported from the
 * `/client` subpath — only the values are). These mirror the confirmed d.ts context
 * shapes used here: the cap hook reads `ctx.selectedRequirements.amount` (string) and
 * may return an abort; the response hook reads the OPTIONAL `ctx.settleResponse`.
 */
interface BeforePaymentCtx {
  selectedRequirements: { amount: string };
}
type BeforePaymentHook = (ctx: BeforePaymentCtx) => Promise<void | { abort: true; reason: string }>;
interface PaymentResponseCtx {
  settleResponse?: { success: boolean; transaction: string };
}
type PaymentResponseHook = (ctx: PaymentResponseCtx) => Promise<void | { recovered: true }>;

/** One rolling hour in ms — the budget window the cap hook checks (mirrors POLICY-02). */
const HOUR_MS = 3_600_000;

/**
 * The result of one settlement attempt. `settled` is the commit gate: forward.ts only
 * commits the grant when `settled === true && txHash` is present (INTEG-04).
 */
export interface SettlementResult {
  settled: boolean;
  txHash?: string;
}

/**
 * The canonical fail-closed settlement. Returned on ANY real-mode failure — a throw,
 * an aborted cap hook, or an unconfirmed settle (no transaction). NEVER carries a tx
 * and NEVER reports `settled: true` (T-04-05). Mirrors `BLOCK_FAILCLOSED`.
 */
export const SETTLE_FAILCLOSED: SettlementResult = { settled: false };

/**
 * The read-only ledger surface the cap hook needs for the rolling-budget check. A
 * structural subset of the real `Ledger` (only `spentSince`), so the unit tests inject
 * a tiny fake and the server passes the real `getCommitStores().ledger`.
 */
export interface CapLedger {
  spentSince(windowMs: number, now?: number): bigint;
}

/**
 * The minimal GatewayClient surface the adapter drives. The real SDK `GatewayClient`
 * is a structural superset; tests inject a fake implementing exactly this shape (so the
 * cap hook + settle-signal logic is provable network-free, like the judge's toVerdict).
 */
export interface GatewayClientLike {
  onBeforePaymentCreation(hook: BeforePaymentHook): unknown;
  onPaymentResponse(hook: PaymentResponseHook): unknown;
  pay(url: string): Promise<PayResult>;
}

/** Dependencies injected into the gateway adapter (the budget ledger + a client factory for tests). */
export interface GatewayDeps {
  ledger?: CapLedger;
  /**
   * Override the GatewayClient constructor (tests only). Production leaves this unset
   * and the real `@circle-fin/x402-batching` `GatewayClient` is built lazily.
   */
  makeClient?: (config: Pick<Config, "arcChain" | "walletPrivateKey">) => GatewayClientLike;
}

/**
 * Build the real-settlement adapter from resolved config. Closes over ONE lazily
 * constructed `GatewayClient` (built only on first use AND only when a key is present),
 * registers the in-process cap backstop + the settle-signal capture, and returns the
 * async settle function the adapter delegates to for `settlementMode === "real"`.
 */
export function makeGatewayAdapter(
  config: Pick<Config, "arcChain" | "walletPrivateKey" | "perCallCapAtomic" | "hourlyBudgetAtomic">,
  deps: GatewayDeps = {},
): (target: URL) => Promise<SettlementResult> {
  // Construct ONE client lazily on first use. We never build it without a key — the
  // empty-key path short-circuits to the stub in the adapter BEFORE this runs, but we
  // re-assert here so a direct caller never constructs against an empty key either.
  let client: GatewayClientLike | null = null;

  // The transaction reference captured by onPaymentResponse — the PRIMARY settle signal
  // (NEVER pay() resolution, RESEARCH Pitfall 2). Reset per call below.
  let settleTx: string | undefined;

  function ensureClient(): GatewayClientLike {
    if (client) return client;
    client = deps.makeClient
      ? deps.makeClient(config)
      : (new GatewayClient({
          chain: config.arcChain as SupportedChainName,
          privateKey: config.walletPrivateKey as Hex,
        }) as unknown as GatewayClientLike);

    // Cap backstop (D-02 / INTEG-03): in-process DETERMINISTIC, NOT on-chain. Aborts
    // before signing when the requirement exceeds the per-call cap OR the rolling-hour
    // budget. BigInt compare only — never float (CLAUDE.md money-as-atomic invariant).
    client.onBeforePaymentCreation(async (ctx) => {
      // CR-02: the paid `amount` is an attacker-controlled string from the 402 the
      // GatewayClient re-fetched. A bare BigInt() would honor "-50000000" (negative —
      // defeats every cap and CREDITS the wallet), "0x10" (hex), " 5 " (whitespace),
      // and throw uncontrolled on "1e3"/"" (escaping the hook). Parse through the same
      // /^\d+$/ guard everything else uses, and FAIL CLOSED on any invalid value.
      let amt: bigint;
      try {
        amt = reqAmountAtomic(ctx.selectedRequirements.amount);
      } catch {
        return { abort: true, reason: "invalid payment amount (in-process backstop)" };
      }
      const spent = deps.ledger ? deps.ledger.spentSince(HOUR_MS) : 0n;
      if (amt > config.perCallCapAtomic || spent + amt > config.hourlyBudgetAtomic) {
        return { abort: true, reason: "exceeds Sentinel cap (in-process backstop)" };
      }
    });

    // Settle signal (INTEG-04): capture the confirmed transaction ref. settleResponse
    // is OPTIONAL on ctx — only a success WITH a transaction is a real settle.
    client.onPaymentResponse(async (ctx) => {
      if (ctx.settleResponse?.success && ctx.settleResponse.transaction) {
        settleTx = ctx.settleResponse.transaction;
      }
    });

    return client;
  }

  return async (target: URL): Promise<SettlementResult> => {
    // Re-assert the key guard (the adapter already routed empty-key real mode to stub,
    // but a direct caller must never sign against an empty key).
    if (!config.walletPrivateKey) return SETTLE_FAILCLOSED;

    settleTx = undefined; // reset the per-call settle signal
    try {
      const c = ensureClient();
      // pay() runs its OWN 402 → sign → settle round-trip and fires the hooks. An
      // over-cap abort makes pay() throw "Payment creation aborted: <reason>".
      const result = await c.pay(target.href);

      // PRIMARY gate: the onPaymentResponse transaction ref. SECONDARY confirm:
      // PayResult.transaction (non-optional string). We require the hook signal so a
      // pay() that resolved without a confirmed settle NEVER commits (Pitfall 2).
      const txHash = settleTx ?? (result.transaction || undefined);
      if (!settleTx) return SETTLE_FAILCLOSED;
      return { settled: true, txHash };
    } catch (err) {
      // ANY throw — abort/network/SDK — fails closed. Log the message ONLY; NEVER the
      // private key (T-04-01).
      console.warn(
        JSON.stringify({
          msg: "settlement failed — fail-closed (no grant)",
          err: (err as Error).message,
        }),
      );
      return SETTLE_FAILCLOSED;
    }
  };
}

/**
 * One-time Gateway funding helper (A5). The Gateway balance starts at 0, so the FIRST
 * real `pay()` cannot settle until USDC is deposited. This is DELIBERATELY a standalone
 * helper — it is NEVER auto-called on boot/server-start: money movement stays an
 * explicit, human-run step for a security proxy (HUMAN DECISION). Run it ONCE (e.g. via
 * `tsx src/settlement/deposit.ts`) against a faucet-funded EOA before the first
 * SENTINEL_SETTLEMENT_MODE=real demo. The private key is never logged here either.
 *
 * @param config arcChain + walletPrivateKey (a funded Arc-testnet EOA).
 * @param amount USDC amount as a decimal string (e.g. "1.00"), per the SDK's deposit() API.
 * @returns the deposit transaction hash.
 */
export async function depositToGateway(
  config: Pick<Config, "arcChain" | "walletPrivateKey">,
  amount: string,
): Promise<string> {
  if (!config.walletPrivateKey) {
    throw new Error("depositToGateway: SENTINEL_WALLET_PRIVATE_KEY is empty — cannot deposit");
  }
  const client = new GatewayClient({
    chain: config.arcChain as SupportedChainName,
    privateKey: config.walletPrivateKey as Hex,
  });
  const result = await client.deposit(amount);
  return result.depositTxHash;
}

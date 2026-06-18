/**
 * Standalone one-time Gateway deposit script (A5) — run ONCE before the live
 * SENTINEL_SETTLEMENT_MODE=real demo. This is NOT wired into the proxy boot path:
 * moving money is a deliberate, human-run step for a security proxy.
 *
 * Usage (from the proxy workspace, with a faucet-funded EOA in the env):
 *   SENTINEL_WALLET_PRIVATE_KEY=0x... tsx src/settlement/deposit.ts [amountUSDC]
 *
 * `amountUSDC` is a decimal string (default "1.00"). Fund the EOA first at
 * https://faucet.circle.com (20 USDC / 2h / address). The private key is never logged.
 */

import { loadConfig } from "../config.js";
import { depositToGateway } from "./gateway.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const amount = process.argv[2] ?? "1.00";
  if (!config.walletPrivateKey) {
    console.error("SENTINEL_WALLET_PRIVATE_KEY is empty — set a funded Arc-testnet EOA key first.");
    process.exit(1);
  }
  console.log(`[deposit] depositing ${amount} USDC to the Gateway on chain ${config.arcChain}...`);
  const txHash = await depositToGateway(config, amount);
  console.log(`[deposit] done — depositTxHash=${txHash}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    // Log the message ONLY — NEVER the private key (T-04-01).
    console.error("[deposit] failed:", (err as Error).message);
    process.exit(1);
  });
}

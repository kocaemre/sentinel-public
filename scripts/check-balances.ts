/**
 * Read-only balance check for the funded Arc-testnet reserve EOAs.
 * Reads private keys from proxy/.env, derives the ADDRESS only (keys are never printed),
 * and queries native (gas) + ERC-20 USDC balances on Arc testnet.
 *
 *   tsx scripts/check-balances.ts
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http, formatUnits, getContract } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Parse proxy/.env (KEY=VALUE lines) and collect anything that looks like a 0x private key.
const envText = readFileSync(new URL("../proxy/.env", import.meta.url), "utf8");
const keys = new Set<string>();
for (const line of envText.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
  if (!m) continue;
  const val = m[2].replace(/^["']|["']$/g, "");
  // a 32-byte private key = 0x + 64 hex
  if (/^0x[0-9a-fA-F]{64}$/.test(val)) keys.add(val);
}

if (keys.size === 0) {
  console.error("No 0x<64-hex> private keys found in proxy/.env (var names checked, values masked).");
  process.exit(1);
}

const client = createPublicClient({ transport: http(RPC) });
const usdc = getContract({ address: USDC, abi: ERC20_ABI, client });

console.log(`Arc testnet (${RPC}) — ${keys.size} reserve EOA(s)\n`);
for (const k of keys) {
  const addr = privateKeyToAccount(k as `0x${string}`).address;
  try {
    const [native, bal] = await Promise.all([
      client.getBalance({ address: addr }),
      usdc.read.balanceOf([addr]) as Promise<bigint>,
    ]);
    console.log(`${addr}`);
    console.log(`   USDC (ERC-20): ${formatUnits(bal, 6)}`);
    console.log(`   native (gas) : ${formatUnits(native, 18)}`);
    console.log(`   explorer     : https://testnet.arcscan.app/address/${addr}\n`);
  } catch (e) {
    console.log(`${addr}`);
    console.log(`   ⚠️  query failed: ${(e as Error).message}\n`);
  }
}

/**
 * Decisive experiment: can we produce a REAL per-payment Arc-testnet settle tx?
 *
 * Stands up a real x402 Gateway-batching SELLER (createGatewayMiddleware → Circle's
 * hosted TESTNET facilitator) and pays it with our funded+deposited buyer wallet via
 * GatewayClient.pay(). If the SDK + facilitator settle on-chain, pay() returns a real
 * transaction hash.
 *
 *   node --env-file=proxy/.env --import tsx reference-agent/src/real-settle-test.ts
 */
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { GatewayClient, type SupportedChainName } from "@circle-fin/x402-batching/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const PORT = Number(process.env.SELLER_PORT ?? 4022);
const CHAIN = (process.env.SENTINEL_ARC_CHAIN ?? "arcTestnet") as SupportedChainName;
const BUYER_KEY = process.env.SENTINEL_WALLET_PRIVATE_KEY ?? "";
if (!BUYER_KEY) {
  console.error("SENTINEL_WALLET_PRIVATE_KEY is empty — run with --env-file=proxy/.env");
  process.exit(1);
}

// A fresh recipient (only ever receives USDC — needs no funds, no key persisted).
const seller = privateKeyToAccount(generatePrivateKey()).address;
console.log(`[seller] address: ${seller}`);

const gateway = createGatewayMiddleware({
  sellerAddress: seller,
  networks: ["eip155:5042002"], // Arc testnet
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  description: "Sentinel real-settle demo resource",
});

const app = express();
app.get("/paid", gateway.require("$0.001"), (req, res) => {
  const pay = (req as unknown as { payment?: { transaction?: string; payer?: string } }).payment;
  res.json({ data: "real protected resource (paid)", settledTx: pay?.transaction, payer: pay?.payer });
});

const server = app.listen(PORT, async () => {
  console.log(`[seller] real x402 seller listening on http://localhost:${PORT}`);
  try {
    const buyer = new GatewayClient({ chain: CHAIN, privateKey: BUYER_KEY as Hex });
    console.log(`[buyer] paying http://localhost:${PORT}/paid on ${CHAIN} …`);
    const result = await buyer.pay(`http://localhost:${PORT}/paid`);
    console.log("\n================ RESULT ================");
    console.log(`status      : ${result.status}`);
    console.log(`amount      : ${result.formattedAmount} USDC`);
    console.log(`transaction : ${result.transaction || "(none)"}`);
    console.log(`data        : ${JSON.stringify(result.data)}`);
    if (result.transaction) {
      console.log(`explorer    : https://testnet.arcscan.app/tx/${result.transaction}`);
      console.log("✅ REAL per-payment settlement confirmed.");
    } else {
      console.log("⚠️  no transaction hash returned — settle did not produce a tx.");
    }
    console.log("=======================================");
  } catch (err) {
    console.error("\n❌ pay() failed:", (err as Error).message);
  } finally {
    server.close();
    process.exit(0);
  }
});

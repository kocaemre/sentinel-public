import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWallet } from "../src/wallet.js";

/**
 * Behavior contract for the shared simulated-balance store (Plan 02-01, Task 1).
 *
 * The wallet is a single row in one SQLite file. Two processes (the agent and the
 * proxy) open it on the same path and observe each other's settles — this is the
 * shared-store invariant that makes the drain-vs-preserve demo contrast real
 * (RESEARCH Pitfall 5 / Open Q1 resolved to shared SQLite). All money math is
 * atomic-unit BigInt; nothing is ever a JS float.
 */

test("resetBalance sets the balance and getBalanceAtomic reads it back (100 USDC atomic)", () => {
  const wallet = openWallet(":memory:");
  // Until reset, the row does not exist → balance is 0.
  assert.equal(wallet.getBalanceAtomic(), 0n);
  wallet.resetBalance(100_000_000n); // 100 USDC atomic
  assert.equal(wallet.getBalanceAtomic(), 100_000_000n);
});

test("two settle(50 USDC) from 100 USDC land exactly on 0n (no float drift)", () => {
  const wallet = openWallet(":memory:");
  wallet.resetBalance(100_000_000n);
  wallet.settle(50_000_000n);
  assert.equal(wallet.getBalanceAtomic(), 50_000_000n);
  wallet.settle(50_000_000n);
  assert.equal(wallet.getBalanceAtomic(), 0n);
});

test("a third settle drives the balance negative (drain past zero is observable; D-04)", () => {
  const wallet = openWallet(":memory:");
  wallet.resetBalance(100_000_000n);
  wallet.settle(50_000_000n);
  wallet.settle(50_000_000n);
  wallet.settle(50_000_000n);
  assert.equal(wallet.getBalanceAtomic(), -50_000_000n);
  assert.ok(wallet.getBalanceAtomic() <= 0n, "balance <= 0 means drained (D-04)");
});

test("two handles on the SAME db path observe each other's settles (shared-store invariant)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-wallet-"));
  const dbPath = join(dir, "wallet.db");
  try {
    const a = openWallet(dbPath);
    const b = openWallet(dbPath);
    a.resetBalance(100_000_000n);
    // Handle B sees the reset written by handle A.
    assert.equal(b.getBalanceAtomic(), 100_000_000n);
    // Write via A, read 0 via B → proves Pitfall 5 is avoided.
    a.settle(100_000_000n);
    assert.equal(b.getBalanceAtomic(), 0n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Atomic-unit (6-decimal USDC) money math — BigInt only, NEVER a JS float.
 *
 * USDC is a 6-decimal token: 1 USDC == 1_000_000 atomic units. Multiplying a
 * human value by `1e6` loses precision (`0.001 * 1e6 === 999.9999999999999`,
 * truncating to 999n instead of 1000n — RESEARCH Pitfall 4). So we parse the
 * decimal string textually: integer part × 10^6 plus the fractional part padded
 * to exactly 6 digits. Every comparison downstream (per-call cap, overpayment,
 * budget, balance) stays in atomic-unit BigInt.
 */

const ATOMIC_DECIMALS = 6;
const ATOMIC_SCALE = 10n ** BigInt(ATOMIC_DECIMALS); // 1_000_000n

/**
 * Convert a human USDC amount (e.g. "0.001", "50", 20) to atomic units via
 * string-parse — never a float multiply.
 *
 *   usdcToAtomic("0.001") === 1000n   (NOT 999n)
 *   usdcToAtomic("1")     === 1000000n
 *   usdcToAtomic(20)      === 20000000n
 */
export function usdcToAtomic(usdc: string | number): bigint {
  const str = typeof usdc === "number" ? usdc.toString() : usdc.trim();
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`invalid USDC amount: ${JSON.stringify(usdc)}`);
  }
  const [intPart, fracPart = ""] = str.split(".");
  // Pad/slice the fractional part to exactly 6 atomic digits (truncate excess).
  const fracPadded = (fracPart + "0".repeat(ATOMIC_DECIMALS)).slice(0, ATOMIC_DECIMALS);
  return BigInt(intPart) * ATOMIC_SCALE + BigInt(fracPadded);
}

/**
 * The wire `maxAmountRequired` is ALREADY in atomic units (the x402 spec sends
 * the integer atomic value), so there is no scaling — but the value is
 * attacker-controlled (it comes from a possibly-malicious 402 body).
 *
 *   reqAmountAtomic("50000000") === 50000000n
 *
 * Defense in depth (CR-01): re-assert the non-negative integer invariant here even
 * though the Zod schema already constrains the field. A bare `BigInt()` would honor
 * "-50000000" (negative — defeats every amount cap and CREDITS the wallet on settle),
 * "0x10" (a valid hex literal), or " 5 " (whitespace), and would throw uncontrolled on
 * "1e3" deeper in the stack. The `/^\d+$/` guard FAILS CLOSED at the parse boundary —
 * the caller (forward.ts) catches the throw and returns the controlled 502 shape.
 */
export function reqAmountAtomic(maxAmountRequired: string): bigint {
  if (!/^\d+$/.test(maxAmountRequired)) {
    throw new Error(`invalid atomic amount: ${JSON.stringify(maxAmountRequired)}`);
  }
  return BigInt(maxAmountRequired);
}

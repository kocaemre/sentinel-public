# Protect your paying agent with Sentinel — one line, no SDK, no config

Sentinel is a transparent x402 payment-security proxy. Point your agent's upstream
through it and every payment your agent makes is screened **before it settles** — a
prompt-injected or malicious `402 Payment Required` is caught and blocked. There is
**no SDK to install and nothing to configure**.

## The one-line swap

Sentinel proxies via a path prefix: put the Sentinel base URL in front of the full
upstream URL your agent already calls.

```diff
- const res = await fetch("https://api.some-x402-service.com/v1/pay");
+ const res = await fetch("https://sentinel.<dev-domain>/https://api.some-x402-service.com/v1/pay");
```

That's it. The shape is always:

```
https://sentinel.<dev-domain>/<your full upstream URL, scheme included>
```

If your client takes a configurable base URL, set it to `https://sentinel.<dev-domain>/`
and prefix your upstream URL — no other change.

## What protection you get (and what you don't)

Protection is **automatic** and matches exactly what Sentinel ships today:

- Non-payment responses stream straight through, unchanged.
- A `402` is **held** by Sentinel (your agent never sees the raw 402): it is run through
  the injection-hardened LLM judge (advisory) and the **deterministic policy gate** (the
  real enforcement — per-call cap, hourly/daily budget, velocity, overpayment, replay,
  denied counterparty). If the payment is unsafe it is **blocked before settlement**.

No new capabilities are promised beyond that gate — Sentinel does not claim
transaction-graph / PII analysis.

## Money safety

The hosted endpoint runs in **stub settlement** — no real USDC is ever spent on your
behalf by the public proxy. It screens and blocks; it does not move your funds.

## Optional: name your agent on the live dashboard

Counting is always on your un-spoofable edge IP (`CF-Connecting-IP`), so **you do not
need to send anything** to be counted as a protected agent. If you'd like a friendly
label next to your agent on the live dashboard, optionally send:

```
X-Sentinel-Agent: my-cool-agent
```

This is purely cosmetic — it never changes whether or how you are counted.

## See your agent appear

Open the live dashboard and watch the **distinct protected agents** counter — once your
agent drives a payment through `https://sentinel.<dev-domain>/...` it shows up as a new
external source (the developer's own traffic is excluded so the number is honest).

Dashboard: `https://<dashboard-url>` · Endpoint: `https://sentinel.<dev-domain>`

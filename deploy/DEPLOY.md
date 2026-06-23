# Sentinel — Deployment Runbook (DIST-01)

Stand the **unmodified** single Node/Fastify proxy up on a free always-on AWS EC2
behind a stable Cloudflare named tunnel, in **stub-settlement mode** with the
strict public-deployment posture. No inbound ports; the tunnel dials out.

> **Live deployment (2026-06) — actual setup, supersedes the t4g/ARM notes below:**
> - **Box:** EC2 **t3.small** (x86_64, 2 GiB) + 2 GB swap, single **30 GB root EBS** volume
>   (no separate `/mnt/ebs`). Ubuntu 24.04/26.04 x86. (t4g.small ARM is the free-tier
>   alternative; pick the AMI arch to match the instance.)
> - **Runtime:** Node 22 + pnpm (corepack) + cloudflared via apt. `pnpm install --filter
>   sentinel-proxy...` in `/opt/sentinel`; SQLite at `/var/lib/sentinel` (service user owns it).
> - **Service:** `sentinel.service` runs **tsx directly** (not `pnpm start` — corepack
>   breaks under the service user). See the unit's NOTE.
> - **Tunnel:** provisioned via the Cloudflare API with a scoped token (Argo Tunnel: Edit
>   + DNS: Edit) using [`cf-tunnel-setup.sh`](./cf-tunnel-setup.sh) — creates the tunnel,
>   sets ingress `→ localhost:8787`, the DNS CNAME, and installs the token-run cloudflared
>   service. Avoids the interactive `cloudflared tunnel login` browser flow (§6 below).
>   Public URL: `https://sentinel.0xemrek.dev`.

> The proxy code is untouched by deployment. Plan 01 added the read endpoints + per-IP
> rate limit + the `source` column the deployment relies on; this runbook only puts the
> process on the internet safely.

---

## 1. Launch the box (AWS Console -> EC2)

- Launch an **EC2 t4g.small** (ARM64 / Graviton2) — auto-enrolled in the t4g free trial
  (750 hrs/mo through 2026-12-31). Ubuntu 22.04+ ARM AMI.
- Attach a **30GB EBS** volume (persistent) for the shared SQLite. The free tier covers
  30GB EBS.
- Security group: **OUTBOUND-only**. Do NOT open an inbound port for the proxy —
  cloudflared dials out (RESEARCH Anti-Pattern; threat T-05-14). Allow inbound SSH (22)
  only from your IP for setup.
- Set a **$1 billing alarm** (AWS Console -> Billing -> Budgets/Alarms) as a cheap
  egress guard (RESEARCH Open Q1 — egress is negligible for a hackathon proxy, but the
  alarm is the decided guard).

## 2. Mount the EBS volume

```bash
lsblk                                  # find the attached volume (e.g. /dev/nvme1n1)
sudo mkfs -t ext4 /dev/nvme1n1         # ONLY on a fresh volume (skips if already formatted)
sudo mkdir -p /mnt/ebs
sudo mount /dev/nvme1n1 /mnt/ebs
echo '/dev/nvme1n1 /mnt/ebs ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab  # survive reboot
sudo chown sentinel:sentinel /mnt/ebs  # the service user owns the DB dir
```

`SENTINEL_DB_PATH=/mnt/ebs/sentinel-wallet.db` (set in /etc/sentinel.env) keeps audit
counts on the persistent volume — they survive a reboot (RESEARCH Pitfall 1).

## 3. Node 22 + pnpm + the repo ON the box

```bash
# Node 22 (nodesource or nvm), then pnpm:
corepack enable && corepack prepare pnpm@latest --activate
sudo useradd -r -m -d /opt/sentinel sentinel   # the non-root service user
sudo -u sentinel git clone <repo-url> /opt/sentinel
cd /opt/sentinel
# Run install ON the box so better-sqlite3 pulls the linux-arm64 PREBUILD (no compile).
# NEVER rsync node_modules from your laptop — the native .node addon is arch-specific
# (RESEARCH Pitfall 2).
sudo -u sentinel pnpm install
sudo -u sentinel pnpm add -F sentinel-proxy @fastify/rate-limit@^11.0.0   # the one new dep
```

## 4. Secrets + posture (/etc/sentinel.env, chmod 600)

```bash
sudo cp deploy/sentinel.env.example /etc/sentinel.env
sudo nano /etc/sentinel.env       # fill SENTINEL_WALLET_PRIVATE_KEY / OPENROUTER_API_KEY,
                                  # set SENTINEL_ALLOWLIST to the demo upstream host:port,
                                  # set SENTINEL_DEV_SOURCE to your egress IP / self-label
sudo chmod 600 /etc/sentinel.env  # root-readable only; NEVER committed (D-09)
```

Confirm the posture: `SENTINEL_SETTLEMENT_MODE=stub`, `SENTINEL_ALLOW_INTERNAL=false`,
a strict `SENTINEL_ALLOWLIST`, `SENTINEL_DB_PATH` on `/mnt/ebs`.

## 5. systemd: keep the proxy always-on

```bash
sudo cp deploy/sentinel.service /etc/systemd/system/sentinel.service
sudo systemctl daemon-reload
sudo systemctl enable --now sentinel
systemctl status sentinel          # active (running); journalctl -u sentinel for logs
```

## 6. cloudflared named tunnel (stable HTTPS, no inbound ports)

Requires a Cloudflare-managed domain (DNS on Cloudflare). Run on the box:

```bash
# install cloudflared (Cloudflare apt repo), then:
cloudflared tunnel login                                   # browser auth to your zone
cloudflared tunnel create sentinel                         # creates <UUID> + ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns sentinel sentinel.<dev-domain> # CNAME -> tunnel (STABLE hostname)
# copy deploy/cloudflared-config.yml -> ~/.cloudflared/config.yml and fill <UUID> + hostname
sudo cloudflared service install                           # run as a systemd service, on boot
```

The credentials JSON (`~/.cloudflared/<UUID>.json`) is a SECRET — box-only, never in git.

## 7. Smoke check

```bash
curl -sS https://sentinel.<dev-domain>/<known x402 path>   # expected non-402 / 402 behavior
curl -sS https://sentinel.<dev-domain>/api/metrics         # JSON metrics, Cache-Control: no-store
```

Confirm no inbound proxy port is open (the tunnel dials out). Reboot the box and confirm
the audit counts persist (SQLite on EBS, not instance store).

---

## Fallback (D-01)

If t4g.small capacity fails, use **Google Cloud e2-micro Always Free** (truly always-free,
no trial expiry; smaller — 0.25-2 vCPU burst, 1GB RAM). Same steps: persistent disk for
the SQLite, `pnpm install` on the box, cloudflared named tunnel, systemd.

## Operations notes

- The public deployment runs `SENTINEL_SETTLEMENT_MODE=stub` ALWAYS (D-04). Real settlement
  is only for the controlled recorded demo (Plan 04), against a fresh DB + pre-funded wallet.
- Secrets are env-only via `EnvironmentFile=` (chmod 600) — never inline in the committed
  unit, never logged (T-04-01).
- `pnpm install` runs ON the box every time (native addon arch lock — never rsync node_modules).

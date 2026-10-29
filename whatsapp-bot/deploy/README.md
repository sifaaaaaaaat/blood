# Moving the WhatsApp bridge off your PC

The bridge is a long-running Node process that drives a real Chrome browser
(`whatsapp-web.js`). Vercel cannot host it: serverless functions have no
persistent disk and no 24/7 process. It needs a small always-on machine.

Pick a host first. The gate is **disk**: the linked-device session must survive
restarts, so anything that wipes its filesystem or sleeps on idle will make you
re-scan the QR code. The second gate is **RAM**: headless Chromium wants ~1 GB.

| Host | Card needed? | Free offer | Verdict |
|---|---|---|---|
| **Azure for Students** | **No** | 750 h/month of a B1s VM + $100 credit, 12 months, renewable while enrolled | **Best no-card option** if you can verify student status. Follow the VM steps below. |
| **Oracle Cloud — Always Free VM** | Yes (identity check, not charged) | 1–4 ARM cores / 24 GB RAM, or 1 GB x86, 200 GB disk, never sleeps | Best overall if a card exists. |
| **An old Android phone** | **No** | Termux + Cloudflare Quick Tunnel | Free forever, no card, no signup. Needs a spare phone — see [Option A](#option-a--an-old-android-phone). |
| **Caasify** | **No** | Containers free through 31 Dec 2026, persistent volumes | Real Linux, no phone needed — see [Option B](#option-b--a-free-container-host). Offer is time-limited. |
| **Google Cloud e2-micro** | Yes | 1 free VM in `us-west1` / `us-central1` / `us-east1` | 1 GB RAM — `setup-vm.sh` adds swap. |
| **Render / Koyeb / Railway / Heroku free tiers** | No (Render) / Yes (Koyeb) | 512 MB RAM | **Not usable here**: they sleep after 15 min of idle, and Render free has no disk, so the session is lost on every wake. |
| **Hetzner / DigitalOcean** | Yes | ~$4–6/month | No signup friction; simplest if you'd rather pay than configure. |

The steps below are automated by [`setup-vm.sh`](setup-vm.sh) and work on any
Debian/Ubuntu VM (Oracle, Azure for Students, Hetzner…). For the two no-card,
no-VM routes see [Option A](#option-a--an-old-android-phone) and
[Option B](#option-b--a-free-container-host) at the end.

---

## 1. Create the VM

### Azure for Students (no credit card)
1. <https://azure.microsoft.com/en-us/free/students> → sign in with your
   **university email**. Requires 18+ and full-time enrolment; no card at all.
2. Portal → **Create a resource → Virtual machine**.
3. Region: **Southeast Asia** or **Central India** (closest to Bangladesh).
4. Image: **Ubuntu 22.04 LTS**. Size: **B1s** — 1 vCPU / 1 GB, which is the
   free 750 h/month allowance. 1 GB is tight for Chromium, so `setup-vm.sh`
   adds a swap file.
5. Authentication: **SSH public key** → *Generate new key pair*, and download
   the private key.
6. Inbound ports: allow **22**, **80** and **443**.
7. Create, note the **public IP**; the Linux user is `azureuser`.

> 750 hours is the whole month (744 h), so this covers one always-on VM. Leave
> the VM running; if the $100 credit runs out, the subscription pauses until
> you contact support.

### Oracle Cloud (needs a card)
1. <https://cloud.oracle.com> → sign up (card for verification only).
2. **Compute → Instances → Create instance**.
3. Image: **Ubuntu 22.04** (or 24.04).
4. Shape: **VM.Standard.E2.1.Micro** (x86, free) — simplest, because Google
   Chrome exists for x86_64. `VM.Standard.A1.Flex` (ARM, up to 4 cores /
   24 GB) also works and is much faster; the script then installs Chromium
   instead of Chrome.
5. Networking: **assign a public IPv4 address**.
6. SSH key: upload yours or let Oracle generate one (download it).
7. Create, then note the **public IP**.

### Google Cloud (alternative)
1. <https://console.cloud.google.com> → **Compute Engine → Create instance**.
2. Region `us-west1` (that is the free one), machine type **e2-micro**,
   boot disk **Ubuntu 22.04**, allow HTTP + HTTPS traffic.
3. Note the external IP.

---

## 2. Open the firewall (cloud side)

HTTPS certificates need inbound 80 and 443. **This is the step people miss.**

- **Oracle:** Networking → Virtual Cloud Networks → your VCN → **Security
  Lists** → Default → **Add Ingress Rules**: source `0.0.0.0/0`, TCP,
  destination ports `80` and `443` (two rules).
- **GCP:** VPC network → Firewall → **Create rule**: ingress, `0.0.0.0/0`,
  TCP `80,443`.

The script handles the *inside* of the machine (iptables/ufw); the cloud
console is the part only you can do.

---

## 3. Run the setup script

Copy the `whatsapp-bot` folder to the VM, or clone the public repo there.
Then:

```bash
ssh ubuntu@<VM_IP>            # Oracle: `ubuntu` · Azure: `azureuser` · GCP: your name
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/sifaaaaaaaat/blood.git
cd blood/whatsapp-bot
sudo bash deploy/setup-vm.sh --token '<YOUR_WHATSAPP_BOT_TOKEN>'
```

`--token` must be **exactly** the value the Vercel app has (or will have) as
`WHATSAPP_BOT_TOKEN`. To generate a fresh one:

```bash
openssl rand -hex 32
```

The script installs Node 22, Chrome, Caddy, a `bridge` system user, the systemd
unit, and opens 22/80/443. It ends by printing your public HTTPS URL:

```
Public URL : https://bridge.<vm-ip>.sslip.io
Health     : https://bridge.<vm-ip>.sslip.io/health
```

`sslip.io` is a public wildcard DNS service — `bridge.203.0.113.9.sslip.io`
resolves to `203.0.113.9`, so **you do not need to buy a domain**. If you have
one, run with `--hostname bridge.yourdomain.com` and point an A record at the VM
first.

---

## 4. Pair the WhatsApp number (one scan)

The session on your PC does not travel with the code, so the phone must be
linked once on the server:

1. Open `https://bridge.<vm-ip>.sslip.io/qr?token=<YOUR_WHATSAPP_BOT_TOKEN>`
2. WhatsApp → **Linked devices → Link a device** → scan.
3. The page reloads itself with a fresh code every 20s; codes expire fast.

Verify:

```bash
curl https://bridge.<vm-ip>.sslip.io/health
# {"ok":true,"ready":true}
```

`ready:false` means the session is not paired yet (open the QR page again).

> The pairing page is token-gated on purpose: anyone who could load it could
> link *their* phone to your session slot.

---

## 5. Point the live site at the new bridge

In Vercel → project **blood** → Settings → Environment Variables, add for
**Production** (and Preview if you want previews to send too):

| Name | Value |
|---|---|
| `WHATSAPP_BOT_URL` | `https://bridge.<vm-ip>.sslip.io` (no trailing slash) |
| `WHATSAPP_BOT_TOKEN` | the same token you passed to the script |

Then **redeploy** — environment variables only apply to new deployments.

Both variables must be present; if either is missing the app deliberately stays
in `mock` mode and records simulated sends instead of contacting WhatsApp.

---

## 6. Verify end to end

1. `curl https://bridge.<vm-ip>.sslip.io/health` → `ready:true`.
2. On the live site, confirm the provider is no longer mock — request
   `/api/notifications/process` health, or check the outbox rows switch from
   `mock / simulated_sent` to `whatsappWeb / delivered`.
3. Create a test blood request in the app for a location where a donor is
   registered; open the donor's WhatsApp. The request card arrives from the
   paired number.
4. Reply `1` (accept) as the donor; the app answers in the same chat, and the
   requester sees the donor's number once the 3-month rule passes.

---

## Option A — an old Android phone

Runs the **same `bot.js`**, no rewrite. Free forever, no card, no signup. Needs
an Android phone (ideally a spare one) that stays on WiFi and plugged in.

**What you need:** the phone, a charger, and Termux installed from
**F-Droid** (<https://f-droid.org/en/packages/com.termux/>) — *not* the Play
Store build, which is a different, broken branch with a different signing key.

```bash
# in Termux
pkg update && pkg install -y git
termux-setup-storage          # grant the Android permission prompt
git clone https://github.com/sifaaaaaaaat/blood.git
cd blood/whatsapp-bot
bash deploy/termux-setup.sh --token '<YOUR_WHATSAPP_BOT_TOKEN>'
```

[`termux-setup.sh`](termux-setup.sh) installs Node and Chromium, takes a wake
lock, writes `.env`, registers a Termux:Boot script, starts a Cloudflare Quick
Tunnel and then runs the bridge in a restart loop. It prints:

```
Public URL: https://<random-words>.trycloudflare.com
Pair here:  http://localhost:3001/qr?token=<YOUR_TOKEN>
```

Pair by opening the **localhost** URL in Chrome *on the phone* (the token stays
out of the tunnel that way), then set `WHATSAPP_BOT_URL` in Vercel to the
`trycloudflare.com` URL and redeploy.

### Things that will bite you

- **The Quick Tunnel URL is random and changes on every restart.** You must
  update `WHATSAPP_BOT_URL` in Vercel and redeploy each time. A named tunnel
  needs a domain you own — the GitHub Student Pack includes a free Namecheap
  `.me` domain, which fixes this permanently and gives the site a nicer URL too.
- **Android kills background apps.** Set Settings → Apps → Termux → Battery to
  **Unrestricted**, keep the wake-lock notification visible, and install
  **Termux:Boot** so it restarts after a reboot.
- **Chromium on Termux is the flaky part.** If pairing fails with `Aw, Snap!` or
a launch error, run Node *and* Chrome inside `proot-distro` Ubuntu instead
  (`pkg install proot-distro`, `proot-distro install ubuntu`, then install
  Google Chrome's arm64 `.deb` there and point `CHROME_PATH` at
  `/usr/bin/google-chrome-stable`).
- Do not use the phone whose WhatsApp you are pairing for anything critical.

---

## Option B — a free container host

The repo now ships a [`Dockerfile`](../Dockerfile) that bundles system Chromium,
so any Docker host works:

```bash
docker build -t roktosathi-bridge whatsapp-bot

docker run -d --name bridge -p 3001:3001 \
  -e WHATSAPP_BOT_TOKEN='<YOUR_WHATSAPP_BOT_TOKEN>' \
  -e APP_INBOUND_URL='https://blood-gamma-nine.vercel.app/api/whatsapp/inbound' \
  -v roktosathi-session:/data \
  roktosathi-bridge
```

On a hosted platform, configure:

| Setting | Value |
|---|---|
| Environment | `WHATSAPP_BOT_TOKEN`, `APP_INBOUND_URL` |
| Volume / persistent disk | mount at **`/data`** — this *is* the session |
| Port | `3001` (most hosts inject `PORT`; the bridge honours that too) |
| Scale-to-zero | **off**, minimum replicas **1** — a sleeping bridge delays every donor alert |
| Health check path | `/health` |

Free-container caveats: **Caasify**'s offer runs only through 31 Dec 2026, and
**Render's** free plan is 512 MB with no disk, which is too small for Chromium
and loses the session — don't use it for this.

If the host needs a repo rather than a local build, point it at
`https://github.com/sifaaaaaaaat/blood` with `whatsapp-bot` as the build context
and it will pick up the same `Dockerfile`.

---

## Operations

| Task | Command |
|---|---|
| Status | `systemctl status roktosathi-bridge` |
| Live logs | `journalctl -u roktosathi-bridge -f` |
| Restart (keeps session) | `sudo systemctl restart roktosathi-bridge` |
| Update code | `sudo git -C /opt/roktosathi-bridge pull && sudo systemctl restart roktosathi-bridge` |
| Re-pair | open `/qr?token=…`, scan; or `rm -rf /var/lib/roktosathi-bridge/*` first |
| Session files | `/var/lib/roktosathi-bridge` (survives reboots and redeploys) |

**Copy over an existing pairing (optional):** instead of scanning again, you can
move the session from your PC:

```bash
# on your PC
scp -r whatsapp-bot/.wwebjs_auth ubuntu@<VM_IP>:/tmp/session
# on the VM
sudo systemctl stop roktosathi-bridge
sudo rm -rf /var/lib/roktosathi-bridge/* && sudo mv /tmp/session/* /var/lib/roktosathi-bridge/
sudo chown -R bridge:bridge /var/lib/roktosathi-bridge
sudo systemctl start roktosathi-bridge
```

Scanning a fresh QR is more reliable; do that if the copied session is rejected.

---

## Honest caveats

- This is an **unofficial** WhatsApp integration (it automates WhatsApp Web with
  a real account). The number can be banned; use a dedicated SIM, not your
  personal one, and send a modest volume.
- One paired number is the send rate limit. For public-scale traffic the
  official WhatsApp Cloud API (free tier ≈ 1,000 conversations/month) is the
  intended replacement; the app's provider layer is already swappable.
- The VM reboots (host maintenance) are handled by `systemd` + the session
  folder, so the bridge comes back paired without intervention.
- If the phone unlinks the device (or is offline too long), the bridge reports
  `ready:false`, the app's outbox keeps retrying, and you re-pair with a QR.

# Moving the WhatsApp bridge off your PC

The bridge is a long-running Node process that drives a real Chrome browser
(`whatsapp-web.js`). Vercel cannot host it: serverless functions have no
persistent disk and no 24/7 process. It needs a small always-on machine.

There is **no free tier that runs headless Chromium with a persistent disk**
(checked: no catalog service offers it — PaaS free tiers sleep on idle and wipe
the disk, which loses the WhatsApp session). The free option that does work is
an **always-free VM**:

| Host | Free offer | Notes |
|---|---|---|
| **Oracle Cloud — Always Free VM** | 1–4 ARM cores / 24 GB RAM, or 1 GB x86, 200 GB disk, **never sleeps** | Best fit. Needs a card for identity verification (not charged). |
| **Google Cloud — e2-micro** | 1 free VM in `us-west1` / `us-central1` / `us-east1`, 30 GB disk | 1 GB RAM — the script adds swap. |
| **Hetzner / DigitalOcean** | ~$4/month | No signup friction; simplest if you'd rather pay than configure. |

Everything below is automated by [`setup-vm.sh`](setup-vm.sh).

---

## 1. Create the VM

### Oracle Cloud (recommended)
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
ssh ubuntu@<VM_IP>            # Oracle Ubuntu user is `ubuntu`; GCP user is your name
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

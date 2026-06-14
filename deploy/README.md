# Deploying ledger on dinosaur (Milestone 1)

Single static binary + systemd + Tailscale HTTPS. No Node, no DB server.

## 1. Build the static binary (build machine)

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ledger ./cmd/ledger
# (use GOARCH=arm64 if dinosaur is ARM)
```

Copy it to dinosaur:

```bash
scp ledger dinosaur:/tmp/ledger
```

## 2. Install on dinosaur

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ledger || true
sudo install -m 0755 /tmp/ledger /usr/local/bin/ledger
sudo mkdir -p /etc/ledger /var/lib/ledger
sudo install -m 0644 config.example.toml /etc/ledger/config.toml
sudo chown -R ledger:ledger /var/lib/ledger
sudo chmod 0700 /var/lib/ledger
sudo install -m 0644 deploy/ledger.service /etc/systemd/system/ledger.service
sudo systemctl daemon-reload
sudo systemctl enable --now ledger
```

Check it:

```bash
systemctl status ledger
curl -s http://127.0.0.1:8080/api/health   # -> {"status":"ok","db":"ok"}
```

## 3. HTTPS over Tailscale (required — service workers need HTTPS)

With Tailscale installed and `dinosaur` on your tailnet:

```bash
sudo tailscale serve --bg 8080
# Serves https://dinosaur.<your-tailnet>.ts.net/ -> 127.0.0.1:8080
tailscale serve status
```

The app is now reachable **only** from your tailnet devices, over HTTPS, never publicly.

## 4. Verify on a phone

On a phone joined to the tailnet, open `https://dinosaur.<tailnet>.ts.net/`.
Expect the XP-styled placeholder card showing `health: ok (db: ok)`.

## Logs & ops

```bash
journalctl -u ledger -f          # follow logs
sudo systemctl restart ledger    # restart (sends SIGTERM -> graceful shutdown)
```

## Backups (one file)

```bash
sqlite3 /var/lib/ledger/ledger.db ".backup '/var/backups/ledger-$(date +%F).db'"
```

Backups contain financial data — encrypt them if they leave the box (Milestone 8 covers Litestream + encryption).

## 5. Dedicated mailbox (Milestone 2 — ingest)

ledger reads a **dedicated mailbox** that contains *only* forwarded bank mail, so its
credential can never reach your personal email (§9). Recommended: a fresh Gmail.

### 5a. Create the mailbox + app password

1. Create a new Gmail used for nothing else, e.g. `salehledgerbank@gmail.com`.
2. Enable **2-Step Verification** (Google Account → Security). Use standard 2SV,
   **not** Advanced Protection (which disables app passwords).
3. Generate a 16-character **App Password** (Security → App passwords). Copy it once.
4. IMAP is on by default for new Gmail accounts; host is `imap.gmail.com:993`.

### 5b. Forward bank mail from your primary inbox

In **iCloud Mail → Settings → Rules** (icloud.com), add one rule per bank sender:

> If a message **is from** `alerts@emiratesnbd.com` → **Forward to** `salehledgerbank@gmail.com`

Repeat for each bank sender. (You can add senders later as you discover them.)

### 5c. Configure ledger on dinosaur

Point config at the mailbox (no secret here):

```toml
# in /etc/ledger/config.toml
[imap]
host          = "imap.gmail.com"
port          = 993
username      = "salehledgerbank@gmail.com"
auth          = "app_password"
folder        = "INBOX"
read_only     = true
poll_interval = "60s"
```

Put the secret in the root-only env file the unit already loads:

```bash
sudo install -m 0600 /dev/stdin /etc/ledger/ledger.env <<'EOF'
LEDGER_IMAP_APP_PASSWORD=xxxxxxxxxxxxxxxx
EOF
sudo chown ledger:ledger /etc/ledger/ledger.env
sudo systemctl restart ledger
```

> The systemd unit reads `EnvironmentFile=-/etc/ledger/ledger.env`. For stronger
> protection, switch to systemd's encrypted credential store (`LoadCredential=` /
> `systemd-creds`) later — the env file is the simplest secure default.

### 5d. Verify ingestion

```bash
journalctl -u ledger -f          # expect "ingest enabled ..." then "ingest: N new message(s)"
curl -s http://127.0.0.1:8080/api/health    # ingest.configured=true, count rises as mail arrives
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "SELECT count(*), max(created_at) FROM ingest_log;"
```

Send a test email from one of the configured bank senders (or wait for a real
transaction alert) and confirm `ingest_log` grows. Because the mailbox is opened
read-only (`EXAMINE`), ledger can never delete or modify the mail.

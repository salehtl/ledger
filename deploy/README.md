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

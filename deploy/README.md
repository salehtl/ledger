# Deploying ledger on dinosaur

Single static binary + systemd + Tailscale HTTPS. No Node, no DB server.

> This runbook covers this repository's app, `ledger`. The multi-user app `ledgerd` also runs on this box, but it was extracted to `github.com/salehtl/ledgerd` on 2026-08-11 and its runbook went with it. A deploy from here must leave `ledgerd.service` running — check both services afterwards.

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

> First install only. On an existing install this block overwrites the live
> `/etc/ledger/config.toml` with `config.example.toml`. To update the binary,
> run only the `install ... /usr/local/bin/ledger` line, then restart.

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

### 3a. Storybook design-system docs (optional)

The static Storybook build is published on its own port so the PWA's service worker
(whose scope is `/` on the app origin) can never intercept it:

```bash
cd frontend && bun run build-storybook
rm -rf /srv/ledger-storybook && mkdir -p /srv/ledger-storybook
cp -r storybook-static/. /srv/ledger-storybook/
sudo tailscale serve --bg --https=8443 /srv/ledger-storybook   # one-time; persists across reboots
```

Docs live at `https://dinosaur.<tailnet>.ts.net:8443/`. After changing stories or
`src/docs/Foundations.mdx`, re-run the build + copy (the serve config stays).
To stop serving: `sudo tailscale serve --https=8443 off`.

## 4. Verify on a phone

On a phone joined to the tailnet, open `https://dinosaur.<tailnet>.ts.net/`.
Expect the app's Home screen.

## 5. Web Push (VAPID)

Push is off until both VAPID vars are set; the server logs which state it is in
at startup (`push: VAPID enabled` / `push: disabled`).

```bash
ledger vapid-keys | sudo tee -a /etc/ledger/ledger.env   # prints both vars
sudo chmod 0600 /etc/ledger/ledger.env
sudo systemctl restart ledger
curl -s localhost:8080/api/push/vapid-public             # sanity check
```

Generate the keypair **once**: regenerating invalidates every stored
subscription, and each device has to re-enable push by hand.

Then, on the phone: Settings → Notifications → "Enable on this device", and
"Send test" to confirm delivery end to end.

On iOS this only works from a PWA **installed to the Home Screen** (Safari →
Share → Add to Home Screen). Web Push never fires in a plain Safari tab, no
matter how the server is configured. Delivery goes via Apple's push service, so
notifications still arrive when the phone is off the tailnet — but tapping one
through to the app needs the tailnet.

## Logs & ops

```bash
journalctl -u ledger -f          # follow logs
sudo systemctl restart ledger    # restart (sends SIGTERM -> graceful shutdown)
```

`scripts/perf-report.sh` reports the v1 PWA's load weight from the committed
`internal/web/dist` (add a `BASE_URL` argument to also measure on-the-wire
transfer sizes against a running server).

## Backups (one file)

```bash
sqlite3 /var/lib/ledger/ledger.db ".backup '/var/backups/ledger-$(date +%F).db'"
```

Backups contain financial data — encrypt them if they leave the box (Milestone 8 covers Litestream + encryption).

## 6. Dedicated mailbox (Milestone 2 — ingest)

ledger reads a **dedicated mailbox** that contains *only* forwarded bank mail, so its
credential can never reach your personal email (§9). Recommended: a fresh Gmail.

### 6a. Create the mailbox + app password

1. Create a new Gmail used for nothing else, e.g. `bank-mail@example.com`.
2. Enable **2-Step Verification** (Google Account → Security). Use standard 2SV,
   **not** Advanced Protection (which disables app passwords).
3. Generate a 16-character **App Password** (Security → App passwords). Copy it once.
4. IMAP is on by default for new Gmail accounts; host is `imap.gmail.com:993`.

### 6b. Forward bank mail from your primary inbox

In **iCloud Mail → Settings → Rules** (icloud.com), add one rule per bank sender:

> If a message **is from** `alerts@emiratesnbd.com` → **Forward to** `bank-mail@example.com`

Repeat for each bank sender. (You can add senders later as you discover them.)

### 6c. Configure ledger on dinosaur

Point config at the mailbox (no secret here):

```toml
# in /etc/ledger/config.toml
[imap]
host          = "imap.gmail.com"
port          = 993
username      = "bank-mail@example.com"
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

### 6d. Verify ingestion

```bash
journalctl -u ledger -f          # expect "ingest enabled ..." then "ingest: N new message(s)"
curl -s http://127.0.0.1:8080/api/health    # ingest.configured=true, count rises as mail arrives
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "SELECT count(*), max(created_at) FROM ingest_log;"
```

Send a test email from one of the configured bank senders (or wait for a real
transaction alert) and confirm `ingest_log` grows. Because the mailbox is opened
read-only (`EXAMINE`), ledger can never delete or modify the mail.

## AI provider (TypeSafe; Anthropic is sunset)

TypeSafe's Jev answers both AI questions: "which category?" and "is this unread
email a transaction?". The second one is the **AI check**. It never writes a
transaction. A confident "not a transaction" sets the email aside (`ignored`,
raw body kept). Anything else stays unparsed, with its verdict stored.

### Config keys

Under `[ai]` in `/etc/ledger/config.toml`:

- `provider`: `"typesafe"` (default) or `"anthropic"`. A bad value stops the
  service at start-up.
- `categorize_provider`: the old name for `provider`. It is still read, but only
  when `provider` is not set.
- `typesafe_model`: the TypeSafe model id. Default `jev-1.13.0`.
- `txn_ignore_threshold`: a "not a transaction" answer at or above this sets the
  email aside. Default `0.97`. It must be above 0.5 and at most 1.
- `model` and `allow_ai_extraction`: used only when `provider = "anthropic"`.

The keys are secrets, so they live in `/etc/ledger/ledger.env`, never in the
TOML: `LEDGER_TYPESAFE_API_KEY` for `typesafe`, `LEDGER_AI_API_KEY` for
`anthropic`.

### Roll out (from categorize_provider)

1. Back up the DB as root:
   `sudo sqlite3 /var/lib/ledger/ledger.db ".backup '/var/backups/ledger-$(date +%F-%H%M).db'"`
   If **AI features** is on in Settings → AI & API usage, turn it off now.
   Otherwise the AI check starts at the default threshold when the new binary
   starts, before you have measured.
2. Build the binary (section 1), then install **only the binary**:
   `sudo install -m 0755 /tmp/ledger /usr/local/bin/ledger`
   (section 1 copies the build to `/tmp/ledger`; if you built on dinosaur
   itself, install `./ledger` instead). Do not re-run section 2 on an existing
   install. It runs `install ... config.example.toml /etc/ledger/config.toml`,
   which overwrites the live config and loses `[imap]` and your other settings.
   The running service keeps the old binary until the restart in step 4.
   The old `categorize_provider = "typesafe"` still works. For clarity, rename
   it to `provider = "typesafe"` in `/etc/ledger/config.toml` under `[ai]`.
   `LEDGER_TYPESAFE_API_KEY` must be in `/etc/ledger/ledger.env` before the
   restart (keys: https://console.typesafe.ai/keys). With `enabled = true` and
   no key, the service refuses to start:
   `ai.provider = "typesafe" requires LEDGER_TYPESAFE_API_KEY env var`.
3. Measure the AI check on a copy. The new binary must already be installed
   (step 2). An older binary does not know `txncheck-eval`: it starts the
   server instead, as root, with default settings that open the production data
   in `/var/lib/ledger`. The command sends each sample's sender, subject and
   up to 8 KB of text to TypeSafe (about 400 emails, a few US cents):

   ```bash
   sudo mkdir -p /root/ts-eval
   sudo sqlite3 /var/lib/ledger/ledger.db ".backup /root/ts-eval/ledger.db"
   sudo sh -c 'set -a; . /etc/ledger/ledger.env; /usr/local/bin/ledger txncheck-eval --data-dir /root/ts-eval'
   ```

   Options: `--per-class N` (emails per label, default 200) and `--model id`.
   It prints one summary line, then one line per threshold. The numbers here
   are an example:

   ```text
   emails 400 (200 transactions, 200 not)  errors 0  unreadable 0
     set aside at >= 0.99: 31 of 200 non-transactions, hides 0 of 200 transactions
     set aside at >= 0.97: 52 of 200 non-transactions, hides 0 of 200 transactions
     set aside at >= 0.95: 66 of 200 non-transactions, hides 1 of 200 transactions
     set aside at >= 0.90: 91 of 200 non-transactions, hides 3 of 200 transactions
     set aside at >= 0.80: 118 of 200 non-transactions, hides 7 of 200 transactions
   ```

   If any email got no answer, it adds two lines after the summary (a 401 is
   a bad key):

   ```text
     first error: …
     K of N emails got no answer; the counts below cover only the answered ones.
   ```

   Fix the cause (key, rate limit) and rerun before you choose. If no email got
   an answer, the command exits with status 1 and logs:

   ```text
   txncheck-eval: no email got an answer; do not choose a threshold from this run
   ```

   Take the lowest threshold whose "hides" count is 0, then use the next higher
   cut as a safety margin. The eval samples mail the parsers already read
   (parsed, and ignored by a template). It does not sample the unread mail the
   check will see, so it understates what the check will hide. Example: if 0.95
   is the lowest clean cut, set 0.97. If the lowest clean cut is 0.99, use 0.99.
   Set the threshold under `[ai]` as `txn_ignore_threshold = 0.97` (the default;
   valid range above 0.5 up to 1).
4. `sudo systemctl restart ledger`. The log must say `provider=typesafe` and
   `txn check=true`: `journalctl -u ledger -n 50 | grep 'clients wired'`
   prints

   ```text
   ai: clients wired (provider=typesafe, model=jev-1.13.0, txn check=true, set aside at >= 0.97); runtime master switch + cap now govern calls
   ```

   with your threshold in place of 0.97. If the log says `ai: disabled`
   instead, set `enabled = true` under `[ai]`.
5. Turn on **AI features** in Settings → AI & API usage.
6. Sort the backlog. Old unread emails have used up their automatic retries,
   so only a manual reprocess reaches them. It runs one call per unread email
   and can take a few minutes:
   `curl -s --max-time 1800 -X POST http://127.0.0.1:8080/api/reprocess`
   Then check the counts: `curl -s http://127.0.0.1:8080/api/health` has
   `ingest.unread` with `transaction`, `not_transaction`, `unchecked` and
   `set_aside`. Settings → Email ingest shows the same numbers as "Emails no
   parser read". An email in "Look like transactions" needs a parser update,
   because the AI check never writes a transaction.

### Undo set-asides

A set-aside row has `parse_status='ignored'` and `parse_tier='ai_check'`. Its
verdict is in `ingest_log.ai_verdict` and `ai_verdict_conf`. To look at the
rows first:

```bash
sudo -u ledger sqlite3 /var/lib/ledger/ledger.db \
  "SELECT id, from_addr, subject, ai_verdict_conf FROM ingest_log WHERE parse_status='ignored' AND parse_tier='ai_check' ORDER BY id DESC LIMIT 30"
```

If the threshold hid real transactions, raise it and reprocess. No SQL is
necessary. Do the restart first: a reprocess replays each stored verdict under
the threshold that is live, so a reprocess before the restart sets the rows
aside again.

1. Raise `txn_ignore_threshold` in `/etc/ledger/config.toml`, then
   `sudo systemctl restart ledger`.
2. Reprocess:
   `curl -s --max-time 1800 -X POST http://127.0.0.1:8080/api/reprocess`

A row whose stored confidence is below the new threshold returns to unparsed,
with no new AI check call. A row that a fixed parser now reads gets its
transaction.

### Bring Anthropic back

Set `provider = "anthropic"` under `[ai]`, keep `LEDGER_AI_API_KEY` in
`/etc/ledger/ledger.env`, and restart. That restores Anthropic categorization,
and Anthropic extraction while `allow_ai_extraction` is true. The AI check is
off under that provider. Answers cached in `ai_suggestions` stay valid under
either provider.

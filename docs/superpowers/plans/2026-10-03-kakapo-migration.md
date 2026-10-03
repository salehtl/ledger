# Move ledger from dinosaur to kakapo: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run ledger 1.0 on kakapo (NixOS home server), declared in `salehtl/kakapo`, with the live database moved over byte for byte. Dinosaur stays the dev box.

**Architecture:** This repository gets a flake: a `buildGoModule` package and a NixOS module (`services.ledger`), checked by a NixOS VM test. kakapo adds this flake as an input, enables the module in `modules/services/ledger.nix`, serves it to the tailnet with `tailscale serve`, and reads its secrets from a new sops file. The database moves in a one-time cutover script that Saleh runs from the Mac. Claude has no SSH access to kakapo.

**Tech Stack:** Nix flakes, NixOS 26.05, sops-nix (age), systemd, Tailscale Serve, Go 1.25, SQLite.

**Spec:** the decisions of 2026-10-03 in this session:
1. Tailnet only. Never the Cloudflare Tunnel.
2. Package and module live in this repository's flake. kakapo consumes it as an input.
3. The URL changes to `kakapo.marmoset-paradise.ts.net`. Reinstalling the PWA and re-enabling push is accepted.
4. `ledgerd` does not move. Sunset it. (Checked: it is already `inactive` and `disabled` on dinosaur. Nothing to do.)
5. Claude installs Nix on dinosaur to build and test. Saleh runs the cutover, because only the Mac can SSH to kakapo.

## Global Constraints

- ledger binds `127.0.0.1` only. No firewall port opens. Ingress is `tailscale serve` on the tailnet.
- No secret enters the Nix store or a repository in clear text. Both repositories are **public**, so the mailbox address stays secret too (`LEDGER_IMAP_USERNAME`).
- The VAPID keypair moves as it is. Never generate a new one.
- The database moves byte-identical: compare sha256 on both ends.
- kakapo `master` deploys itself at 04:00 Asia/Dubai. Push to a branch. Merge to master only after `nixos-rebuild test` on the host passes.
- kakapo: `nix fmt` clean and `nix flake check` green before every push.
- Tests never touch dinosaur's live service: not `:8080`, not `/var/lib/ledger`.
- ledger's gate is `go test ./... && cd frontend && bun run test`. The committed `internal/web/dist` must match the frontend source at the commit that kakapo pins.

## Review Focus

1. **ledger starts on kakapo before the copy arrives.** It would make a fresh DB, ingest the whole mailbox and send each email through the paid AI check. Expected: the unit does not start until `ledger.db` exists. Pinned by the VM test (`requireDatabase`).
2. **The secrets do not reach the service** (wrong YAML key, a lost line, the file is not wired). Expected: the service starts only with every `LEDGER_*` name present. Pinned by the sops round trip (Task 3), the VM test (the env file must be read for a healthy start), and the cutover pre-flight (it compares key names).
3. **Two ledgers ingest at once** (dinosaur restarts after the cutover: a reboot, or a parallel session that follows the old runbook). Expected: dinosaur's unit stays down. Pinned by the cutover: `disable`, plus a drop-in condition on a marker file.
4. **Unattended nightly deploys skip the "back up first" step.** Expected: a copy of the DB before each new build first touches it. A crash loop must not rotate that copy out. Pinned by the VM test (once per build; keep the newest five).
5. **The 04:00 upgrade reverts a `nixos-rebuild test`.** Expected: the cutover ends by moving branch `ledger` to kakapo master and running `switch`. If that fails, it says how much time is left and what to run.

---

### Task 0: Nix on dinosaur

- [ ] Install multi-user Nix with the official installer (`--daemon --yes`).
- [ ] In `/etc/nix/nix.conf`: `experimental-features = nix-command flakes`, `max-jobs = 1`, and `system-features = nixos-test benchmark big-parallel kvm`. Dinosaur has no `/dev/kvm`. QEMU falls back to TCG, so the VM test is slow but runs.
- [ ] Cap the daemon so that a build cannot starve the live ledger: `systemctl set-property nix-daemon.service MemoryHigh=1500M MemoryMax=2500M`. Run large client evaluations in `systemd-run --scope -p MemoryMax=2500M`.
- [ ] Check: `nix --version` and `nix eval --raw nixpkgs#go.version` (must be at least 1.25).

### Task 1: ledger flake: package, module, VM test

**Files:**
- Create: `flake.nix`, `flake.lock`, `nix/package.nix`, `nix/module.nix`, `nix/test.nix`
- Modify: `.gitignore` (add `/result`, `/result-*`)

**Interfaces:**
- Produces: `packages.<system>.default` (name `ledger-1.0-<shortRev>`), `nixosModules.default`, `checks.<system>.{package,module}`.
- Options: `services.ledger.{enable, package, settings, environmentFile, requireDatabase, backupsToKeep}`. `settings.server.listen` defaults to `127.0.0.1:8080`. `settings.server.data_dir` is read-only `/var/lib/ledger`.

- [ ] **Write the failing test first** (`nix/test.nix`). One VM with `requireDatabase = true`, `settings.server.listen = "127.0.0.1:8091"`, `ai = { enabled = true; provider = "typesafe"; }`, and an env file with `LEDGER_TYPESAFE_API_KEY=test-only`. ledger refuses to start with AI on and no key, so a healthy start on port 8091 proves both wires: the TOML is read (port) and the env file is read (key). Script:
  - `/var/lib/ledger` is `700 ledger` before any start. `ConditionResult` is `no`. Nothing answers on 8091.
  - Copy in an empty `ledger.db` (mode 0600, owned by ledger). Start the unit. `/api/health` reports `"db":"ok"`. No backup yet (an empty file is a fresh install).
  - Restart: exactly one `backups/before-*.db`. Restart again: still one. The `backups` directory is mode 700.
  - Add six old dummy backups (`touch -d 2020-01-0N`). Restart: five remain, and the real one is among them.
- [ ] Run `nix build .#checks.x86_64-linux.module`. Expect FAIL: the module does not exist yet.
- [ ] Write `nix/package.nix`: `buildGoModule`. The source is a fileset of `go.mod go.sum cmd internal`. `subPackages = [ "cmd/ledger" ]`, `CGO_ENABLED=0`, `doCheck = false` (the repository gate runs the tests), `meta.mainProgram = "ledger"`. Get `vendorHash` from a first build with `lib.fakeHash`.
- [ ] Write `nix/module.nix`. Port the sandbox settings from `deploy/ledger.service`. Add `UMask=0077`, a `tmpfiles` rule for `/var/lib/ledger` (0700 ledger:ledger, so that the copy has a target before the first start), `ConditionPathExists` when `requireDatabase` is set, and an `ExecStartPre` script. The script copies a non-empty DB to `backups/before-<package basename>.db` once per build (`sqlite3 .backup` to `.part`, then `mv`), and then keeps the newest `backupsToKeep`.
- [ ] Write `flake.nix`: nixpkgs `nixos-26.05`, systems x86_64-linux and aarch64-linux. `nixosModules.default` imports `nix/module.nix` and sets `services.ledger.package` with `mkDefault` from the host's `pkgs`, with `rev = self.shortRev or self.dirtyShortRev or "dirty"`.
- [ ] Run the VM test. Expect PASS.
- [ ] **Prove it bites.** Do each mutation, watch the test fail, then revert: (a) drop `EnvironmentFile`; (b) drop `ConditionPathExists`; (c) drop the once-per-build `if`. Record each result.
- [ ] Commit: `feat(nix): flake with package, NixOS module and VM test`.

### Task 2: Fresh dist, gate, land on main

- [ ] Run `cd frontend && bun install --frozen-lockfile && bun run build`. If `git status internal/web/dist` shows a change, commit it.
- [ ] Run `go test ./...` (`-count=1`).
- [ ] Fast-forward `main`. Check `git diff --cached --name-only` first. Then `git push origin main`. kakapo pins this commit.

### Task 3: kakapo secrets file

**Files:** Create `kakapo/secrets/ledger.yaml`. It holds one value, `ledger.env`: a multi-line copy of `/etc/ledger/ledger.env` (the `LEDGER_*` lines) plus `LEDGER_IMAP_USERNAME` from `/etc/ledger/config.toml`.

- [ ] Build the plain text in memory only, never on disk. Encrypt it with `sops --encrypt --filename-override secrets/ledger.yaml` from kakapo's root, so `.sops.yaml` picks both recipients (mac, kakapo).
- [ ] Round trip: encrypt the same text to a throwaway age key in the scratchpad. Decrypt with `--extract '["ledger"]["env"]'`. Its sha256 must equal the sha256 of the plain text. The key names must equal the names in `/etc/ledger/ledger.env` plus `LEDGER_IMAP_USERNAME`. Delete the throwaway key.
- [ ] Check the real file: two age recipients, matching `.sops.yaml`; no clear-text value.

### Task 4: kakapo module, on branch `ledger`

**Files:**
- Modify: `flake.nix` (input `ledger`, `inputs.nixpkgs.follows = "nixpkgs"`; add `ledger.nixosModules.default` to the modules list), `flake.lock`
- Create: `modules/services/ledger.nix`: `services.ledger` with `requireDatabase = true`, listen `127.0.0.1:8090`, the IMAP settings from `/etc/ledger/config.toml` without the username, `ai = { enabled = true; provider = "typesafe"; }`, and a `ledger-tailscale-serve` oneshot unit (`tailscale serve --bg --https=443 http://127.0.0.1:8090`; on stop `--https=443 off`; retries until tailscaled is up)
- Modify: `modules/sops.nix` (`secrets."ledger/env"` with `sopsFile = ../secrets/ledger.yaml` and `restartUnits = [ "ledger.service" ]`), `hosts/kakapo/default.nix` (import), `CLAUDE.md` (architecture entry, the tailnet-only exception, a deploy recipe)

- [ ] Run `nix fmt`, then `nix flake check`. The same checks as CI.
- [ ] Evaluate the toplevel `drvPath`. Build `config.systemd.units."ledger.service".unit` and the `ledger-tailscale-serve` unit. Read the rendered units.
- [ ] Commit on branch `ledger`. Push the branch. **Do not touch master.**

### Task 5: Cutover script

**Files:** Create `deploy/cutover-kakapo.sh` (this repository) and `deploy/cutover-kakapo.test.sh` (a stub `ssh` and `git` record the call sequence).

Steps, in order. Each one checks before it acts:
0. Pre-flight: ledger is active on dinosaur. `sqlite3` is on dinosaur. kakapo has no `ledger.db*`. Port 8090 is free on kakapo. Show `tailscale serve status` and ask before replacing a foreign config.
1. `nixos-rebuild test --flake github:salehtl/kakapo/ledger#kakapo --refresh`. Then check: the `ledger` user exists; `/var/lib/ledger` exists; `/run/secrets/ledger/env` has the same key **names** as dinosaur's env file plus `LEDGER_IMAP_USERNAME`; ledger is not running; the serve unit is active.
2. Stop ledger on dinosaur. **Downtime starts. From here, any exit that is not success rolls back:** stop kakapo's ledger, move `ledger.db*` aside, and start dinosaur's ledger again.
3. Snapshot on dinosaur: `umask 077; sqlite3 .backup` to `/var/backups/ledger-<stamp>-to-kakapo.db`, then `PRAGMA integrity_check` = `ok`.
4. Stream it to kakapo with `install -o ledger -g ledger -m 0600 /dev/stdin`. The sha256 must match.
5. Start ledger on kakapo. Wait for `/api/health` on loopback, then on `https://kakapo.marmoset-paradise.ts.net` from the Mac. Check that the running exe equals ExecStart's binary, and that one `before-*.db` backup exists.
6. Retire dinosaur: disable the unit, add the drop-in `ConditionPathExists=!/var/lib/ledger/MOVED-TO-KAKAPO`, and touch the marker.
7. Ask, then fast-forward kakapo `master` to `ledger` (refuse if it is not a fast-forward) and run `nixos-rebuild switch` from master. If this fails, print the commands and the time left before 04:00.

- [ ] Write the test first: (a) happy path; (b) health fails at step 5, so the rollback runs and dinosaur starts again; (c) kakapo already has a DB, so the script stops before anything stops on dinosaur. Run it: FAIL (no script yet).
- [ ] Write the script. Run the test: PASS. Run `shellcheck` on both files.
- [ ] Prove it bites: disarm the rollback, and test (b) must fail.
- [ ] Commit and push to main.

### Task 6: Hand-off, then after Saleh's cutover

- [ ] Give Saleh the run command and the phone steps: delete the old Home Screen app; add `https://kakapo.marmoset-paradise.ts.net` from Safari; Settings → Notifications → "Enable on this device" → "Send test".
- [ ] After he confirms: rewrite the deploy story in `CLAUDE.md` and `deploy/README.md` (prod = kakapo; deploy = lock bump; the old systemd steps move to an appendix). Remove dinosaur's `tailscale serve` 443 route. Update the memories `dinosaur-is-deploy-target` and `ledger-smoke-test-uses-prod-by-default`.

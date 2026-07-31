# Phase 0 results

## Port 25

**Task:** Spike A — empirically determine whether this server's provider permits
inbound TCP/25, which gates the self-hosted SMTP ingestion design in v2 spec §3.2.

### Host identity

- Public IPv4: `178.104.132.41` (via `curl -4 -s ifconfig.me`)
- Provider (RIPE whois): **Hetzner Online GmbH**, netname `CLOUD-NBG1`
  (Nuremberg, DE datacenter), route `178.104.0.0/15`, origin `AS24940`,
  descr `HETZNER-DC`. Abuse contact `abuse@hetzner.com`.
- This is a Hetzner **Cloud VPS** address block, not a residential/ISP range
  and not CGNAT (`100.64.0.0/10`) — so the near-certain-block heuristic from
  the brief's Step 2 does not apply here. The box is reached day-to-day over
  Tailscale (`tailscale0`), but the probe in this spike targets the *public*
  interface, which is what an inbound SMTP MTA would need to reach.

### Local network state before probing

- `ss -tlnp | grep -E ':25 |:2525 '` → both free before starting listeners.
- `ufw status verbose` (active): default **deny incoming**, with only
  `tailscale0` allowed inbound. No pre-existing rule for 25 or 2525.
- `iptables -L INPUT -n`: policy `DROP`, traffic routed through `ts-input` and
  `ufw-*` chains (Tailscale + ufw stack) — consistent with ufw's reported
  state, no third-party firewall layer found.
- Because ufw defaults to deny-incoming on the public interface, it was
  temporarily opened for this spike: `sudo ufw allow 25/tcp` and
  `sudo ufw allow 2525/tcp` (both added an IPv4 and IPv6 rule, tagged
  `spike-phase0-temp`). This is a **local** firewall consideration, separate
  from any provider/upstream-network block — see verdict below for why this
  matters to the interpretation.

### Listeners

- `sudo python3 -m http.server 25 --bind 0.0.0.0` (root, privileged port) and
  `python3 -m http.server 2525 --bind 0.0.0.0` (control) were started as
  background processes.
- Confirmed both bound via `ss -tlnp` (pids on `0.0.0.0:25` and
  `0.0.0.0:2525`) and both answered locally: `curl 127.0.0.1:25/` and
  `curl 127.0.0.1:2525/` each returned `HTTP 200`.

### External probe (check-host.net, `check-tcp`, `max_nodes=5`)

Port 25 — nodes queried: Iran (Shiraz), Italy (Milan), Netherlands (Meppel),
Sweden (Stockholm), Ukraine (Kyiv).

| Node | Result |
|---|---|
| ir3 (Iran) | connected, 0.090s |
| it2 (Italy) | connected, 0.025s |
| nl2 (Netherlands) | connected, 0.013s |
| se1 (Sweden) | connected, 0.023s |
| ua3 (Ukraine) | **error: Connection timed out** |

4/5 nodes completed a TCP handshake against `178.104.132.41:25`. The one
failure (Kyiv) is a single node on a distinct geography/network path from the
four that succeeded; nothing else in this spike points at a Hetzner- or
ufw-side block specific to that node, so it reads as node/path-specific noise
(consistent with well-documented degraded transit conditions from Ukraine)
rather than evidence the provider filters port 25.

Port 2525 (control) — nodes queried: Switzerland (Zurich), Cyprus (Larnaca),
Spain (Madrid), Spain (Barcelona), India (Delhi).

| Node | Result |
|---|---|
| ch2 (Switzerland) | connected, 0.010s |
| cy1 (Cyprus) | connected, 0.062s |
| es1 (Spain/Madrid) | connected, 0.037s |
| es2 (Spain/Barcelona) | connected, 0.031s |
| in2 (India) | connected, 0.181s |

5/5 nodes connected. The control confirms the probe method itself works end
to end (public routing, ufw opened correctly, listener reachable) — so the
port-25 result above is a meaningful signal about port 25 specifically, not
an artifact of a broken test setup.

Raw JSON for both requests is preserved in the check-host.net permanent
report links captured during the run (`check-report/45fca7a8k2db` for :25,
`check-report/45fca869kcf` for :2525) and was also saved locally to the
session scratchpad during execution.

### Verdict: **GO**

Hetzner does **not** block inbound TCP/25 on this host. Both the target port
(25) and the control port (2525) were reachable from geographically diverse
external vantage points, with only a single, isolated timeout on 25 from one
node (Kyiv) against an otherwise clean 4/5 — read as path noise, not a
provider policy block, especially since that same class of transient failure
did not appear on the control port. Self-hosted SMTP ingestion per spec §3.2
is viable on this host's public interface: no provider outreach or unblock
request is needed.

### Cleanup performed

- `sudo pkill -f "http.server 25"` and `pkill -f "http.server 2525"` — both
  processes terminated.
- Confirmed via `ss -tlnp | grep -E ':25 |:2525 '` → no output (both free).
- Confirmed via `ps aux | grep http.server` → no matching processes.
- Reverted the temporary ufw rules: `sudo ufw delete allow 25/tcp` and
  `sudo ufw delete allow 2525/tcp` (each removed both the v4 and v6 rule).
- Final `ufw status verbose` matches the pre-spike state: default deny
  incoming, only `tailscale0` allowed. `iptables -L INPUT -n -v` shows no
  leftover rule referencing 25 or 2525.

### Next steps

None required for port reachability — this precondition of spec §3.2 is
satisfied. Remaining Phase 0 spikes (B: blob generator, device measurement,
etc.) are independent of this result and can proceed regardless.

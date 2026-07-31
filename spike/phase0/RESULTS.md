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

4/5 nodes completed a TCP handshake against `178.104.132.41:25`. A
provider-level inbound block on port 25 would fail *every* external probe
uniformly, regardless of which node originates it — a single successful
handshake is already sufficient to rule that out, and here four independent,
geographically diverse nodes succeeded. That makes the outcome dispositive
for the question this spike asks (does Hetzner/this host block inbound 25),
independent of what happened with the fifth node.

The ua3 (Kyiv) timeout is therefore not evidence of a Hetzner-side block; the
most plausible explanation is that ua3 itself — a check-host.net probe node
running on its own commodity hosting — has outbound TCP/25 blocked by *its*
provider, which is the single most common cause of exactly this signature
(one node fails to originate a connection to 25 from anywhere) and is a
well-known limitation of public TCP-checker services, not a property of the
target. This is a plausible explanation, not a confirmed one — it was not
independently verified (e.g. by asking ua3 to probe a known-open port 25
elsewhere) — but no re-probing was required to reach the verdict, since the
four successes already answer the question.

Port 2525 (control) — nodes queried: Switzerland (Zurich), Cyprus (Larnaca),
Spain (Madrid), Spain (Barcelona), India (Delhi).

| Node | Result |
|---|---|
| ch2 (Switzerland) | connected, 0.010s |
| cy1 (Cyprus) | connected, 0.062s |
| es1 (Spain/Madrid) | connected, 0.037s |
| es2 (Spain/Barcelona) | connected, 0.031s |
| in2 (India) | connected, 0.181s |

5/5 nodes connected. Note that check-host.net assigns a fresh, randomly
selected node set per request — the control's five nodes (ch2, cy1, es1, es2,
in2) are entirely disjoint from port 25's five (ir3, it2, nl2, se1, ua3); ua3
was never asked to probe 2525, so this control says nothing about whether ua3
specifically can reach this host at all, and it cannot be used to argue that
ua3's port-25 timeout is anomalous relative to "the same node on the control."
What the control *does* establish is that the probe method itself works end
to end (public routing, the temporary ufw hole, the listener) — a clean 5/5
here confirms the harness is capable of producing all-success results, which
matters mainly as a sanity check and would become the load-bearing evidence
only in the scenario where port 25 saw zero connections (i.e. it disambiguates
"nothing reached us because the harness is broken" from "nothing reached us
because 25 is blocked" — the case that didn't occur here).

Raw JSON for both requests is preserved in the check-host.net permanent
report links captured during the run (`check-report/45fca7a8k2db` for :25,
`check-report/45fca869kcf` for :2525) and was also saved locally to the
session scratchpad during execution.

### Verdict: **GO**

Hetzner does **not** block inbound TCP/25 on this host. The verdict rests on
the four successful external handshakes to port 25 (Iran, Italy, Netherlands,
Sweden): a provider-level inbound-25 block would produce failures across the
board, so even one success would be dispositive, and four independent,
geographically diverse successes make the case solidly. The fifth node's
(ua3, Kyiv) timeout does not weigh against this — it is most plausibly that
probe node's own outbound-25 restriction (a common limitation of TCP-checker
services), not a signal about this host or Hetzner. The control port (2525,
5/5) is not being used here to explain away the ua3 timeout — its nodes were
disjoint from port 25's and it says nothing about ua3 specifically — it
served only to confirm the probe harness itself is capable of reaching this
host end to end, which was not otherwise in doubt given four raw successes on
25. Self-hosted SMTP ingestion per spec §3.2 is viable on this host's public
interface at the provider level: no provider outreach or unblock request is
needed.

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

The **provider-level** precondition of spec §3.2 is satisfied — no Hetzner
outreach or unblock request is needed. But this spike's cleanup step
(correctly) deleted the temporary ufw rules and restored the host's firewall
to its normal default-deny-incoming state with only `tailscale0` allowed. As
recorded above, that means **port 25 is currently unreachable from the
public internet on this host**, by the host's own firewall rather than by
the provider. Anyone implementing the SMTP receiver from spec §3.2 must not
read this GO verdict as "port 25 already works" — before the receiver ships:

1. Add a permanent `sudo ufw allow 25/tcp` (and the matching v6 rule) when
   the SMTP receiver is ready to bind, scoped as tightly as the design
   allows (e.g. restrict source if the sending MTAs are known, though
   inbound mail generally requires open access).
2. Check the Hetzner Cloud **Firewall** feature at the project/panel level
   (a separate layer from the host's own `ufw`/`iptables`, not inspected in
   this spike) — if a Cloud Firewall is attached to this server, it can
   independently block 25 upstream of the host and must be opened too.

Remaining Phase 0 spikes (B: blob generator, device measurement, etc.) are
independent of this result and can proceed regardless.

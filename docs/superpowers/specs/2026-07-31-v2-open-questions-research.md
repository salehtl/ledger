# v2 open questions: FX rate source + backup-relay VPS

**Date:** 2026-07-31
**Status:** Research complete, pre-implementation. Answers the two open questions in `2026-07-31-multi-user-beta-design.md` §6 that gate Phase 1 planning (§3.7 FX; §3.2 backup relay).
**Method:** Web search + primary-source fetches (provider docs/ToS) where possible, live API calls where the provider allows anonymous requests, direct curl of listed vendor endpoints to verify claims that vendor marketing pages get wrong. Community reports (forums, aggregator blogs) are marked as such and dated; nothing from a blog is treated as confirmed without a primary source alongside it. Provider terms and free-tier limits are notoriously volatile — treat every "current" claim below as **as-of 2026-07-31** and re-check before Phase 1 ships if that's more than a few weeks out.

---

## Question 1: FX rate source (spec §3.7)

### Requirements recap

One upstream call/day (total, not per user); daily rates; ~170 currencies; server fetches the **entire table for a base currency** in one response (never per-pair — a per-pair query is a travel-history side channel); needs a **historical backfill** (spec's own budget: "a couple MB once, few hundred bytes/day incremental" for ~170 currencies × days); home currency is user-chosen (likely AED or USD) so the source must support deriving cross-rates from a single base table; this runs for years, so licensing/redistribution terms toward end users matter.

The corpus this app cares about is **AED, USD, EUR, GBP** — AED being the operator's own home currency. This turned out to be the single most decisive filter: several well-regarded "free forever" sources simply don't carry AED.

### What I verified directly (not just vendor copy)

- **Frankfurter (`api.frankfurter.dev`, ECB-backed)** markets itself in blog coverage as covering "201 currencies / 84 central banks," which is false for the actual public API. I called `GET https://api.frankfurter.dev/v1/currencies` live: it returns exactly **30 currencies**, and **AED is not among them** (nor is any GCC currency) — because it mirrors the ECB's own reference-rate publication, which only covers currencies the ECB itself publishes against EUR. I confirmed this independently by fetching the ECB's own reference-rates page: **32 currencies, no AED**, "published for information purposes only." This disqualifies both Frankfurter and the raw ECB `eurofxref` XML feed as a *primary* source for this app, despite both being the best-behaved options on every other axis (free, unlimited, full history to 1999, no ToS friction) — **AED is not there and never will be**, since it isn't ECB-published data.
- **`open.er-api.com`** (ExchangeRate-API's keyless "open access" tier): live call to `GET https://open.er-api.com/v6/latest/USD` returns 161 currencies including `"AED":3.6725` (correct peg). Free, no signup, one JSON response per base currency — matches the "fetch the whole table, never per-pair" requirement exactly. **No historical endpoint on this tier.**
- **Open Exchange Rates (`openexchangerates.org`)**: `GET https://openexchangerates.org/api/currencies.json` (keyless) returns **173 currencies**, confirmed AED/USD/EUR/GBP all present — this is almost exactly the spec's "~170 currencies" figure. Their published Forever-Free-plan table (via their own pricing-guide article, fetched directly) shows: 1,000 requests/month, hourly updates, **historical data included on the free plan** (`historical/YYYY-MM-DD.json`, one date per call), base currency fixed to USD on free (fine — cross-rates from a USD table are exactly what the spec asks for), and bulk **time-series is Enterprise-only ($47/mo)** — not needed if backfill is done as individual per-date calls.
- **`exchangerate.host`**: confirmed via its own GitHub issue tracker that this is **effectively dead as a free/open service** — acquired by APILayer, the original free unauthenticated API was discontinued, and the maintainer's pinned issue says "this repository is dead," redirecting users to a paid, key-gated APILayer product. This is a live example of exactly the longevity risk the spec worries about, and it's disqualified.
- **Fixer.io**: free plan is capped at 100–1,000 req/month depending on which page you read (inconsistent even on their own marketing), **base currency locked to EUR on the free tier**, and **historical data is paid-only**. APILayer-owned (same conglomerate as the dead exchangerate.host), which is itself a small ding against multi-year reliability.
- **currencyapi.com**: free plan is 300 requests/month, 10/min, and is explicitly restricted to **"Private Use"** (commercial use requires the paid "Small" tier, $9.99/mo for 15,000 req/mo). Their marketing page lists "Historical Rates" as a free-tier feature, but a second summary of the same docs said historical is paid-only — **I could not resolve this contradiction from either the pricing page or the docs page** (the docs page 500'd on fetch); flag as unverified. Currency coverage/AED presence also unconfirmed for this vendor specifically (never got a clean answer past an auth wall).
- **A source not in the original list, found during research — `fawazahmed0/exchange-api`** (formerly `currency-api`), a popular open-source project distributed via jsDelivr CDN + Cloudflare Pages fallback, no key, no rate limit. Live call confirmed **338 currencies+metals+crypto, AED present (3.6725)**. This looked like a strong "better option" candidate, but on closer check the historical-by-date access is versioned through npm package tags, and **the oldest published tag is `2024.10.1`** (npm registry, checked directly) — meaning confirmed historical depth is only **~21 months**, not the ~3 years the corpus needs. Dates I tried before that (2023-01-15, 2020-01-01) all 404. It's also a single-maintainer aggregator with no ToS/license I could find and no SLA — real longevity risk for a multi-year beta. Good as a zero-cost *daily* redundancy leg, not trustworthy as sole source of historical backfill or as the primary.

### Licensing/redistribution — the part every vendor is vague about

The spec's architecture literally fetches once and **redistributes the full table to every client** — this is exactly the pattern most FX-API terms are written to prevent ("don't build a competing data-resale product").
- **ExchangeRate-API** (covers both the free `open.er-api.com` tier and its paid tiers — their ToS says explicitly the license "does not restrict Free Plan accounts differently to paid accounts") states in its own terms: *"data gathered from our API cannot be re-distributed — caching is for customer end-use only"* and bars use *"in any product or service that offers programmatic or automatic access to exchange rate data."* Read literally, syncing the fetched table down to every device via our own sync API is arguably exactly that. This is the strictest, most explicit prohibition of any candidate — **I would not build the primary path on this vendor given that wording**, even though it's technically the easiest integration.
- **Open Exchange Rates**' Acceptable Use Policy only bars "reproduce, duplicate, copy or re-sell any part of our site" and their FAQ frames the commercial line as "if you're building a commercial or ad-supported app... please sign up for a paid account" — a much softer, pay-for-what-you-use framing rather than an outright anti-redistribution clause, and their entire paid tier structure is explicitly marketed at app developers embedding rates in a product. This is *not* the same as an explicit blessing of the "fetch once, sync table to every client" pattern, though — **I could not find text that directly confirms or forbids it**. I'd send one clarifying email to `legal@openexchangerates.org` describing the exact architecture before shipping Phase 1, but the risk profile here is materially better than ExchangeRate-API's.
- **currencyapi.com**'s free tier is "Private Use" only by explicit ToS language, which would technically disqualify the free plan for a multi-user product regardless of technical fit — the $9.99/mo Small plan explicitly permits commercial use and would be the compliant tier if this vendor is used at all.
- **Frankfurter/ECB**: no redistribution restriction found (ECB reference rates are official EU statistics, and Frankfurter's own code is MIT-licensed) — the best ToS posture of anything evaluated, moot only because of the AED gap.

### Comparison table

| Candidate | Free ongoing (1 call/day) | ~170 currencies incl. AED/USD/EUR/GBP | Historical backfill on free tier | Single-base cross-rates | Redistribution terms | Status |
|---|---|---|---|---|---|---|
| **Open Exchange Rates** | Yes — 1,000 req/mo free | **Yes, 173 confirmed live** incl. AED | Yes, per-date endpoint, free plan | Yes (USD base) | Soft "pay if commercial," ambiguous on our sync pattern — verify with legal@ | **Recommended (primary)** |
| ExchangeRate-API open access (`open.er-api.com`) | Yes — free, no key | Yes, 161 currencies incl. AED (live-verified) | **No** — not on this tier | Yes | Explicit "may not redistribute" / "no product offering programmatic access" — real conflict with our architecture | Fallback for daily fetch only, not backfill; ToS risk |
| Frankfurter / ECB direct | Yes — free, unlimited | **No — 30/32 currencies, no AED** (live-verified) | Yes, excellent (to 1999) | Yes (EUR base) | Cleanest terms of any candidate | Disqualified (no AED) |
| currencyapi.com | 300 req/mo free / $9.99 mo Small (commercial) | Unconfirmed | Contradictory claims, unresolved | Yes | Free = "Private Use" only | Possible paid fallback, unverified |
| Fixer.io | 100–1,000 req/mo free, EUR-base only | 170 claimed, EUR-locked base on free | No (paid only) | Only via triangulation on free tier | Unconfirmed | Weak — disqualified for practical use |
| exchangerate.host | N/A — dead as free service | N/A | N/A | N/A | N/A | Disqualified (defunct) |
| `fawazahmed0/exchange-api` (found during research) | Yes — free, unlimited, no key | **Yes, 338 confirmed live** incl. AED | Partial — confirmed depth only ~21 months (npm tags start 2024.10.1) | Yes | None found; unlicensed OSS aggregator, single maintainer | Good zero-cost daily-redundancy leg; not primary, not sole backfill source |

### Exact endpoints (Open Exchange Rates, recommended primary)

- Daily fetch (ongoing): `GET https://openexchangerates.org/api/latest.json?app_id=<KEY>` — returns the full table, USD base, once/day is trivially inside the 1,000/mo free cap (~30/mo used).
- Historical backfill (one-time): `GET https://openexchangerates.org/api/historical/YYYY-MM-DD.json?app_id=<KEY>` — one call per date needed. A 3-year backfill is ~1,095 calls: spread over ~2 calendar months on the completely free plan (no cost), or done in a single day on one month of the $12/mo Developer plan if the backfill needs to happen fast before Phase 1 ships (cancel after).
- Currency metadata (keyless, no app_id needed): `GET https://openexchangerates.org/api/currencies.json`.

### Recommendation

**First choice: Open Exchange Rates**, Forever Free plan to start (1,000 req/mo, hourly updates but we only need 1/day, USD-fixed base, 173 currencies confirmed including AED, historical per-date endpoint included on the free tier). Budget for the $12/mo Developer plan once the beta is a real product rather than a personal project — this is consistent with the spec's own "$5/mo is fine" cost tolerance elsewhere and removes the free-plan's soft "please pay if commercial" ambiguity entirely.

**Fallback:** if OXR's redistribution terms turn out (after the legal@ email) to be incompatible with syncing the full table to every client, fall back to **currencyapi.com's Small plan ($9.99/mo)**, which explicitly permits commercial use — pending confirmation of its AED coverage and its historical-endpoint plan-gating, both unresolved in this pass. For the narrow case of *same-day operational redundancy* if the daily OXR call fails, `open.er-api.com` or `fawazahmed0/exchange-api` are viable zero-cost secondary fetches — but note the spec's own review-queue pattern ("unknown-rate transactions surface in the client review queue rather than silently distorting budgets") already tolerates a stale/missing day gracefully, so a formal secondary provider is a nice-to-have, not a hard requirement.

**Do not use:** Frankfurter or the raw ECB feed as primary (no AED, confirmed live — this is not a documentation gap, the data literally isn't published), `exchangerate.host` (dead), Fixer free tier (EUR-locked base, no free historical).

### Confidence / what to verify before committing

- **High confidence, directly verified:** Frankfurter/ECB's AED gap (live API + live ECB page), OXR's 173-currency coverage and AED/USD/EUR/GBP presence (live API), OXR's free-tier historical-endpoint inclusion (fetched pricing-guide table), ExchangeRate-API's explicit anti-redistribution ToS wording (fetched terms page), exchangerate.host's death (GitHub issue tracker).
- **Needs verification before Phase 1:** (1) Send the clarifying email to OXR's `legal@openexchangerates.org` describing the exact "fetch once, sync full table to every device" architecture — I could not find text that unambiguously blesses or forbids this specific pattern, only the general "don't resell/redistribute the site" and "pay if commercial" framing. (2) Resolve the currencyapi.com historical-on-free-plan contradiction directly with their support if it's ever needed as a real fallback (their docs page 500'd during this research — try again, or ask support directly). (3) Confirm currencyapi.com's currency coverage explicitly includes AED before relying on it as a fallback. (4) All free-tier limits above are snapshot-as-of-today; FX API pricing pages change often (exchangerate.host is the cautionary tale) — re-verify OXR's Forever Free terms at Phase 1 kickoff, not just now.

### Sources

- [Frankfurter API](https://frankfurter.dev/) — marketing claim vs. live `api.frankfurter.dev/v1/currencies` (verified directly, 30 currencies, no AED)
- [ECB Euro foreign exchange reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
- [ExchangeRate-API — Open Access docs](https://www.exchangerate-api.com/docs/free)
- [ExchangeRate-API — Terms](https://www.exchangerate-api.com/terms)
- [Open Exchange Rates — signup/plan comparison](https://openexchangerates.org/signup)
- [Open Exchange Rates — plans & pricing guide](https://support.openexchangerates.org/article/69-plans-pricing-guide)
- [Open Exchange Rates — Terms](https://openexchangerates.org/terms)
- [Open Exchange Rates — Acceptable Use Policy](https://openexchangerates.org/acceptable-use)
- [Open Exchange Rates — API introduction docs](https://docs.openexchangerates.org/reference/api-introduction)
- [currencyapi.com — pricing](https://currencyapi.com/pricing/)
- [Fixer.io](https://fixer.io/)
- [exchangerate.host — GitHub issue #245, "this repository is dead"](https://github.com/Formicka/exchangerate.host/issues/245)
- [fawazahmed0/exchange-api README](https://github.com/fawazahmed0/exchange-api)
- npm registry for `@fawazahmed0/currency-api` (checked directly for oldest published version tag)

---

## Question 2: Backup-relay VPS provider (spec §3.2)

### Requirements recap

Must permit **INBOUND** port 25 (the relay only ever *receives* mail and spools ciphertext — it does not need to send/relay outbound SMTP itself, since "forwarding blobs to the primary on recovery" is an application-level sync, not necessarily a re-relay over SMTP); ~$5/mo budget; a real VPS (arbitrary Go binary, not a PaaS/managed relay); must be a **different provider/failure domain** than the primary (Hetzner Cloud, NBG1 — confirmed today via live TCP probe from this repo's Phase 0 spike that Hetzner permits inbound 25 on that host).

**This flips almost every search result on its head.** Nearly all "port 25 blocked" documentation and community complaint threads online are about **outbound** SMTP (a VPS sending spam), which every mainstream provider restricts by default as an anti-abuse measure. Our requirement is the opposite direction — a mail server *receiving* connections on 25 — which is a network-layer inbound-firewall question, not an anti-spam-abuse question, and is consequently almost never the thing these blog posts and docs pages are actually about. This makes direction the single most important thing to get right when reading any of these sources, and most secondary sources (aggregator blogs, "VPS review" sites) do not make the distinction at all.

### Provider-by-provider findings

| Provider | Inbound :25 policy | Confidence | Direction of evidence | Cost (cheapest usable) | Notes |
|---|---|---|---|---|---|
| **Vultr** | **Allowed by default, no request needed.** Official docs quote: outbound port blocking is described as blocking "several outbound ports for network security," explicitly listing TCP 25 as an *outbound* block; inbound is not restricted. | **High** — primary source (docs.vultr.com) | Explicitly outbound-only | $3.50–5/mo (avoid the $2.50 IPv6-only tier — a mail relay needs a real IPv4) | Different company/network/jurisdiction from Hetzner (US-HQ, global DC footprint) — clean failure-domain separation |
| **Netcup** | Believed unrestricted inbound by default; outbound 25 is blocked by default but **self-service** removable via their own firewall panel (no support ticket, unlike most competitors) | **Medium** — community forum consensus (netcup community/German forums), not an explicit provider doc statement for the inbound direction specifically | Community-sourced, direction inferred | €2.75–5.75/mo (~$3–6/mo) | German company, separate from Hetzner but same jurisdiction; recommend empirically probing before committing (see below) |
| **Contabo** | Outbound port 25 "open by default" per aggregator coverage; inbound not directly documented but Contabo is broadly known as permissive on port policy | **Medium-low** — aggregator/community sourced | Mostly about outbound; inbound not explicitly addressed | ~$5.20/mo entry (VPS 10) | Known reputation risk: Contabo IP ranges have a documented history of prior-abuse blacklisting (matters for sending reputation, less for a receive-only relay, but still a flag) |
| **OVH** | **Contradictory across sources** — one community/support thread frames it as "port 25 blocked by default, contact support to unblock" (direction unstated, but the typical OVH framing is about *sending* mail), another says "open by default"; also reportedly **varies by region/datacenter** | **Low** — could not resolve from docs alone | Ambiguous | Comparable to Hetzner/Vultr, ~€4–6/mo | Do not rely on this without an empirical test (see Verification section) |
| **DigitalOcean** | Official docs (`docs.digitalocean.com/support/why-is-smtp-blocked`) state ports 25/465/587 "are blocked on Droplets to prevent spam," **without specifying direction**, and explicitly state there is **no way to unblock**, ever | **Low-medium confidence it's outbound-only, but zero recourse if wrong** | Ambiguous in DO's own doc | ~$4–6/mo | **Not recommended** — the combination of directional ambiguity and DO's stated policy of never granting exceptions makes this the worst risk/reward of the mainstream providers for this specific job |
| **BuyVM** | Third-party aggregator coverage claims a **stateless edge block on ports 25/465/587/2525 "regardless of direction"** by default, unblockable via a billing/sales ticket | **Low** — secondary source only; BuyVM's own Acceptable Use Policy (fetched directly) only documents port 25 in the context of Tor exit-node configuration, says nothing about default account policy | Secondary source claims both directions blocked | ~$2–3.50/mo (cheapest of all candidates) | If the "blocks both directions" claim is accurate this is disqualifying without a ticket; worth a direct pre-sales question given the price point |
| **Linode/Akamai** | Restrictions are documented (official Akamai techdocs) as being about **outbound** connections specifically ("restrictions have been placed on outbound connections over ports 25, 465, and 587") | **High** for outbound; inbound not separately addressed but implicitly unrestricted since only outbound is named | Explicitly outbound in official docs | ~$5/mo | Reasonable secondary fallback candidate, not evaluated as deeply as Vultr/Netcup here |
| **Oracle Cloud (Always Free)** | Official release note (docs.oracle.com) says specifically **"outbound TCP port 25 to the internet"** is blocked for tenancies created after June 2021; OCI's default network model (Security Lists/NSGs) is a self-service allow-list you control yourself, so inbound 25 is plausibly enable-able without any provider ticket | **Medium** — the outbound-only wording is a direct quote from an official doc, but I found no explicit statement confirming inbound works, only the implication from what's *not* named as blocked | Explicit for outbound; inbound inferred, not confirmed | **$0/mo** (Always Free tier) | Attractive on cost, but Oracle's Always Free tier has a well-known **capacity/availability problem** (hard to provision, can be reclaimed) — a bad fit for a component whose entire purpose is being a reliable redundancy backstop. Worth a cheap third-leg experiment, not the fallback pick. |
| **Scaleway** | Outbound SMTP ports blocked by default, unblock requires **national ID + bank statement / company documents** — heavier KYC friction than any competitor | **Medium**, from Scaleway's own docs/community, but only addresses outbound | Outbound-focused | ~€5/mo | Deprioritized due to KYC friction even though not clearly worse on inbound |
| **Hetzner, different region** | N/A — same company/network/billing/ToS as the primary | High (this is definitional, not a policy question) | N/A | N/A | **Explicitly not a valid choice** per the spec's own framing: shares a failure domain with the primary regardless of datacenter |

### Recommendation

**First choice: Vultr.** This is the only candidate where a primary-source provider doc explicitly and unambiguously states that the port-25 restriction is outbound-only, meaning **no unblock request is needed at all** for a receive-only relay — the exact requirement here. Pick an IPv4-capable plan ($3.50–5/mo, not the $2.50 IPv6-only tier), a different company/network/jurisdiction from Hetzner (US-headquartered, global DC footprint vs. Hetzner's German base) giving genuine failure-domain separation.

**Fallback: Netcup.** Cheap (€2.75–5.75/mo), and its self-service firewall (toggle outbound 25 yourself, no ticket) is the most operator-friendly of any candidate if outbound is ever needed later. The inbound-unrestricted claim here is **community-sourced, not from an explicit official doc** — before committing, run the exact same empirical probe already used and committed for Hetzner in this repo (`spike/phase0/RESULTS.md` Task 1: stand up a throwaway listener on :25, probe from outside via check-host.net's TCP-check API) against a cheap Netcup test instance. That's a $3–6 one-month spend to get a real, first-party answer instead of relying on forum consensus.

**Explicitly avoid without further testing:** DigitalOcean (directional ambiguity paired with a stated zero-exception policy — worst risk/reward combination found), BuyVM (secondary-sourced claim of a bidirectional default block), OVH (contradictory and reportedly region-dependent — don't trust either direction claim without a live test), Oracle Cloud Free Tier (plausible $0 option but capacity/eviction risk is a bad match for a redundancy component — fine as a bonus third leg, not the fallback).

### Exact procedure to request an unblock (only needed if a fallback choice turns out to require it)

- **Vultr:** not needed for inbound; if outbound is ever wanted, file a Vultr support ticket describing the mail-relay use case — approved case-by-case per their own docs.
- **Netcup:** self-service — outbound 25 can reportedly be toggled directly in the vServer's firewall panel with no ticket (community-reported; confirm on the actual account).
- **OVH / Linode / Hetzner** (only relevant if either becomes a candidate later): open a support ticket citing a legitimate mail-server use case; Linode's documented bar is having valid forward + reverse DNS configured and CAN-SPAM-compliant practices; Hetzner's is having at least one paid invoice on the account first (≈30 days).

### Confidence / what to verify before committing

- **High confidence:** Vultr's outbound-only wording (direct quote from `docs.vultr.com/what-ports-are-blocked`), Oracle's outbound-only wording (direct quote from Oracle's own release note), Linode's outbound-only wording (Akamai techdocs).
- **Medium confidence, needs a live test before committing:** Netcup's inbound-unrestricted status is inferred from community forum discussion, not an explicit provider statement — **run the Phase 0 port-25 probe script (already built and committed at `spike/phase0/RESULTS.md` Task 1) against a real Netcup instance before finalizing the fallback choice.** This is the single most important unresolved item in this section, since the fallback recommendation currently rests on secondary sources.
- **Low confidence / unresolved:** OVH's actual policy (contradictory sources, reportedly region-dependent — don't use without a direct test), whether BuyVM's default block is genuinely bidirectional (only found in aggregator coverage, BuyVM's own AUP doesn't address it outside the Tor exit-node context).
- **General caveat:** every port-25 policy in this table is a default that individual providers change without much notice, and abuse-history on a specific reassigned IP can produce a de facto block even when the stated policy is "open" (this bit at least one Contabo user per the community reports found). The only fully trustworthy answer for any of these, including the fallback pick, is the same empirical TCP probe already used for Hetzner today — treat this table as narrowing the search, not as a substitute for that test on whichever provider is actually chosen.

### Sources

- [Vultr — What ports are blocked](https://docs.vultr.com/what-ports-are-blocked) (primary, direct quote used)
- [DigitalOcean — Why is SMTP blocked?](https://docs.digitalocean.com/support/why-is-smtp-blocked/) (primary, direction ambiguous in the doc itself)
- [BuyVM — Acceptable Use Policy](https://buyvm.net/acceptable-use-policy/) (primary; only addresses Tor exit-node config, not default account policy)
- [Akamai/Linode — Linodes FAQ](https://techdocs.akamai.com/cloud-computing/docs/faqs-for-compute-instances) and [Send email on Akamai Cloud](https://techdocs.akamai.com/cloud-computing/docs/send-email)
- [Oracle Cloud — Outbound SMTP is blocked (release note)](https://docs.oracle.com/en-us/iaas/releasenotes/changes/f7e95770-9844-43db-916c-6ccbaf2cfe24/)
- [Scaleway — Fix common issues with Instances](https://www.scaleway.com/en/docs/instances/troubleshooting/fix-common-issues/)
- netcup community forum threads (`forum.netcup.de`) — secondary/community source, dated 2026-07-31 search
- [OVHcloud Community — SMTP server on VPS and port 25 opening](https://community.ovhcloud.com/t/smtp-server-on-vps-and-port-25-opening/740/2) — secondary, contradictory with other OVH coverage
- This repo's own `spike/phase0/RESULTS.md` and `docs/superpowers/plans/2026-07-31-v2-phase0-kill-risks.md` Task 1 — the empirical probe method to replicate against Netcup/OVH before final commitment

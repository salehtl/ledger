# YNAB Competitive Teardown (2025–2026, web + iOS)

> Input research for the ledger v3 scope (`docs/v3/scope.md`). Compiled 2026-07-29 from YNAB's own docs/blog, app-store reviews, Trustpilot, and community discussion. Lightly edited for the ledger context: the "what beating YNAB would require" section is written for a **single-user, self-hosted, zero-manual-entry** app.

## Core model

YNAB is **zero-based envelope budgeting on actual cash only**. The engine is not tracking — it's *allocation*:

- **Give Every Dollar a Job.** Every dollar that arrives lands in **Ready to Assign** (green banner at top of Plan/Home) and must be pushed into a category until Ready to Assign = $0.00. You budget only money you *have*, never forecast income. Assigning more than you have turns the banner red (over-assigned).
- **The Four Rules** (classic): 1) Give Every Dollar a Job, 2) Embrace Your True Expenses (break large irregular costs — insurance, car repair, Christmas — into monthly set-asides), 3) Roll With the Punches (overspending isn't failure; move money between categories, guilt-free), 4) Age Your Money (spend increasingly older dollars; break paycheck-to-paycheck).
- **May 2025 method refresh:** the Four Rules were reframed as **Five Questions** ("What does this money need to do before I'm paid again? What larger, less frequent spending do I need to prepare for? What can I set aside for next month? What goals do I want to prioritize? What changes do I need to make?"). Same engine; softer, question-driven framing that treats plan-adjustment as success, not failure.
- **The category balance is the spending decision surface.** Users don't ask "what's my bank balance," they ask "what's left in Dining Out." Everything else (sync, reports, targets) exists to make that per-category "available" number trustworthy and current.
- **Credit cards are modeled as debt locations, not spending sources.** Budgeted cash silently migrates from the spending category to a "Credit Card Payment" category on every card purchase, so the payment is always pre-funded. This is YNAB's most distinctive (and most confusing) mechanism.
- **Trust is maintained by ritual:** import → approve/categorize → reconcile weekly. The methodology *requires* 5–10 minutes of engagement most days.

## Feature inventory

| Feature | What it does | Why users love it |
|---|---|---|
| Ready to Assign flow | Inflows pool in one number; user drags it to categories until zero; red state on over-assignment; Auto-Assign fills per targets/history in one tap | The moment of intentionality; "paycheck ritual" is the habit loop that makes YNAB sticky |
| Category targets | Three types: Set Aside Each Month, Refill Up To (top-up), Have a Balance By Date; weekly/monthly/yearly/custom-date cadences; color-coded progress, computes "needed this month" | Turns annual/irregular bills into calm monthly numbers; underfunded amounts are one tap to fix via Auto-Assign |
| True Expenses / rollover | Unspent category money rolls forward month to month (envelope persistence) | Sinking funds without spreadsheets; the $600 car repair is "boring" because it's already there |
| Move money / Roll With the Punches | Cover overspending by pulling from any other category in two taps; overspent categories flagged red/yellow (cash vs credit overspend) | Guilt-free flexibility is the emotional differentiator vs. rigid budgets |
| Bank sync (direct import) | Plaid/MX/TrueLayer connections auto-pull transactions and balances into the register as unapproved entries | Removes bulk of data entry (in US/Canada/UK/EU) |
| Approve + match | Imported transactions arrive "unapproved"; manual entries auto-match with imports and self-approve; unapproved items still hit the plan | Keeps human in the loop so category balances stay *trusted*, not just recorded |
| Reconciliation | Guided "does YNAB match your bank?" check; cleared/uncleared states; auto-creates a balance adjustment on mismatch | Weekly ceremony that keeps trust in every number; users cite "I finally believe my balances" |
| Scheduled & repeating transactions | Future-dated transactions in the register with repeat rules; upcoming items show in category "upcoming" hints; "Enter Now" option | Rent/subscriptions enter themselves; upcoming bills visibly claim their money in advance |
| Split transactions | One transaction split across multiple categories/payees (Costco = groceries + household); splits can be scheduled | Real shopping doesn't fit one category; splits keep category truth intact |
| Credit card handling | Card accounts get an automatic Credit Card Payment category; budgeted spending on the card auto-moves cash to it; payments are transfers; supports paydown targets for carried debt | "Float without floating" — pay the card in full painlessly; famously powerful *once understood* |
| Loan planner / payoff simulator | Loan accounts with rate/term; burndown chart; slider to simulate extra payments showing interest + time saved live | Making "$100 extra = $1,000 interest saved, 17 months sooner" tangible drives payoff motivation |
| Reports | Spending Breakdown (category donut/trends), Income v Expense (monthly matrix w/ averages & totals), Net Worth (assets vs debts over time), Age of Money; 2025–26 "remodel" added a customizable reports dashboard | Progress porn: net-worth line going up and AoM rising are the shareable wins on r/ynab |
| Age of Money | Average days between earning a dollar and spending it | A single gamified metric for "am I still paycheck-to-paycheck?" |
| Multi-account | Unlimited checking/savings/cash/credit/loan **budget** accounts + **tracking** accounts (investments, mortgage, house) that count in net worth but not the envelope plan | One plan across all money locations; "it's all one pool of dollars, accounts are just where they sleep" |
| YNAB Together | Share subscription with up to 5 people; real-time co-editing of a shared budget; each person keeps own login; mix shared + private budgets | Couples budgeting is a top-cited reason for loyalty; both partners see the same category truth live |
| Mobile app + widgets + Watch | Full-featured iOS app; home-screen widgets showing favorite category balances + quick transaction entry; Apple Watch category glance | "Check the category in the checkout line" — the decision surface lives in the pocket |
| Sync across devices | Real-time cloud sync web ↔ iOS ↔ Android ↔ iPad ↔ Watch | Enter on phone, plan on desktop, instantly consistent |
| Onboarding/education | Free daily live workshops, video courses, podcast, enormous docs, evangelist community (~200k on r/ynab) | The education *is* the product for many; converts skeptics into tattoo-getting devotees |
| CSV import + public API | File-based import fallback; well-documented REST API with big third-party ecosystem (widgets apps, Splitwise bridges, MCP servers) | Power users script around every gap; API is quietly a major retention feature |

**What users praise most** (App Store 4.8/56k, Google Play 4.7/22k, Reddit): the *method* changing their relationship with money ("life-changing," debt paid off, first emergency fund); guilt-free flexibility; credit-card float mastery; couples' shared budgets; the paycheck-assignment ritual; community and support quality.

## Weaknesses & complaints

1. **Price — the #1 complaint.** $14.99/mo or $109/yr, risen repeatedly (some tiers cited up to $179); most-cited grievance on Reddit/Trustpilot; no free tier; "unjustifiable for passive trackers."
2. **Steep learning curve.** 2–4 weeks to basic comfort, 2–4 months to fluency; heavy abandonment in the first two weeks. Credit-card handling is the single biggest conceptual wall ("behaves differently from every other app").
3. **Ongoing manual labor.** Even with sync, users must approve, categorize, and reconcile continuously; 5–10 min/day. Lapse for two weeks and the budget is stale enough that many rage-quit or "Fresh Start."
4. **Bank sync fragility.** Third-party aggregators (Plaid/MX) break on bank security changes; re-linking, multi-day import gaps, duplicate/missed transactions. Sync barely works outside North America/UK/EU — a top reason international users leave.
5. **No multi-currency.** Single currency per budget; foreign accounts and travel are hacks.
6. **Privacy/cloud dependence.** Budget and bank credentials live on their servers; no offline/local mode; self-hosters defect to Actual Budget over exactly this.
7. **No forecasting/investment depth.** Deliberately won't project future income or model investments beyond tracking-account balances; users wanting projections bolt on spreadsheets.
8. **Recent UI churn + in-app promos.** The 2025–26 "Great YNAB Remodel" drew one-star reviews: unexplained redesigns, busy interface, and in-app promotional pop-ups that feel off-mission.
9. **Reports are shallow for power users.** Historic complaint; custom trends/deeper slicing still lag spreadsheet exports.
10. **Split + scheduled edge cases,** weak handling of reimbursements/shared expenses (hence the Splitwise-bridge cottage industry).

## What "beating YNAB" requires for a single-user, self-hosted, zero-manual-entry app

YNAB's moat is the *method* + the trustworthy per-category "available" number; its tax is price, labor, sync fragility, and cloud dependence. A rival wins by keeping the first and deleting the second.

### Must match (table stakes of the model)

- **Envelope truth:** categories with persistent rollover balances, a single "left to spend in X" number per category that's always current and always correct. This is the product; reports are secondary.
- **An assignment moment:** some equivalent of Ready to Assign — income lands, user allocates (or a plan auto-allocates per 50/30/20 with one-tap overrides). Without an intentionality ritual it's just tracking, which YNAB users explicitly reject.
- **Targets:** at minimum monthly set-aside + refill-to + save-by-date with "needed this month" math; irregular-expense smoothing (True Expenses) is the rule users say saved them.
- **Roll With the Punches:** two-tap move-money between categories with overspend flags. Flexibility, not enforcement.
- **Scheduled/repeating transactions** feeding "upcoming" hints, and **split transactions** — both are baseline hygiene.
- **Core reports:** spending breakdown, income vs expense, net-worth line. Age of Money is cheap to compute and is YNAB's best gamification — steal it.
- **Pocket-level access:** PWA installed on phone, glanceable category balances (widget-equivalent = fast home screen / push digest).

### Where the rival structurally wins (press these)

- **Zero manual entry as the headline.** Email-ingest kills YNAB's biggest ongoing tax: no approve-every-import treadmill, no reconciliation ceremony, no 5-min/day tithe. But note the trade: YNAB's approval ritual is what makes users *trust* the numbers — the rival must replace it with visible provenance (raw email retained, review queue only for genuinely ambiguous items, drift alerts when parsing degrades) so trust survives automation. "Nothing silently dropped" is the direct answer to "did sync miss something?"
- **No aggregator, no breakage.** Bank emails arrive regardless of Plaid outages, geography, or bank API politics — an outright win in regions YNAB abandons (and AED/multi-region users specifically).
- **$0 forever vs $109/yr.** Self-hosted single binary vs subscription: the #1 complaint, deleted.
- **Privacy.** Data never leaves the box (one disableable merchant-string AI path) vs full financials on YNAB's cloud — the exact wedge Actual Budget rides, plus zero-entry which Actual lacks.
- **Learning curve.** 50/30/20 auto-plan + rules-first auto-categorization can deliver day-one value with no 4-week methodology bootcamp; let envelope depth be opt-in progressive disclosure rather than a prerequisite.

### Honest gaps to scope consciously (don't accidentally promise)

- **Credit-card float machinery** — YNAB's auto-migrating payment category is deep work; for a single user it may be replaceable with a simpler "card balance vs reserved cash" view, but *some* answer is needed since card emails are the main event source.
- **Balance ground-truth:** email ingest sees transactions, not authoritative balances — a lightweight periodic balance check-in (or balance-notification parsing) substitutes for reconciliation.
- **Cash/no-email spending:** ATM and cash spend never email; needs a fast manual-entry escape hatch or it silently corrodes category truth. (ledger already has manual entry via `AddTransactionSheet`.)
- **Not needed for single-user scope:** YNAB Together/multi-user, loan payoff simulator (nice-to-have later), Watch app, multi-budget — dropped for free.

## Sources

[YNAB Method update](https://www.ynab.com/blog/the-method-gets-an-update) · [Foundations: The YNAB Method](https://www.ynab.com/guide/foundations-the-ynab-method) · [Features](https://www.ynab.com/features) · [Targets guide](https://support.ynab.com/en_us/getting-started-with-targets-ryAEP08xC) · [How to Use YNAB's Targets](https://www.ynab.com/blog/ynab-targets) · [Assigning Your Money](https://support.ynab.com/en_us/assigning-your-money-a-guide-SypgkrNJi) · [Negative Ready to Assign](https://support.ynab.com/en_us/when-ready-to-assign-is-negative-an-overview-HylZA0zCc) · [Auto-Assign](https://support.ynab.com/en_us/auto-assign-a-guide-r1gBNbBJo) · [Approving & Matching](https://support.ynab.com/en_us/approving-and-matching-transactions-a-guide-ByYNZaQ1i) · [Reconciling](https://support.ynab.com/en_us/getting-started-with-reconciling-accounts-an-overview-Sy3JWx4Js) · [Scheduled Transactions](https://support.ynab.com/en_us/scheduled-transactions-a-guide-BygrAIFA9) · [Split Transactions](https://support.ynab.com/en_us/split-transactions-a-guide-SJLEKwY0q) · [Credit cards in YNAB](https://www.ynab.com/blog/how-to-manage-credit-cards-in-ynab) · [Credit card handling](https://support.ynab.com/en_us/handling-credit-cards-overview-ry7cNub1s) · [Loan Planner](https://www.ynab.com/blog/ynab-loan-planner) · [Debt Management](https://www.ynab.com/features/debt-management) · [Reports & data](https://www.ynab.com/blog/ynab-reports-and-data) · [Age of Money](https://support.ynab.com/en_us/age-of-money-H1ZS84W1s) · [Net Worth](https://support.ynab.com/en_us/net-worth-BkwQO5WA5) · [Income v Expense](https://support.ynab.com/en_us/income-v-expense-Byu1BYWRq) · [Spending Breakdown](https://support.ynab.com/en_us/spending-breakdown-H1H7YxmD0) · [Widgets on iOS](https://www.ynab.com/blog/widgets-for-ynab-on-ios) · [Widget guide](https://support.ynab.com/en_us/ynab-widget-for-mobile-a-guide-HJPEEQYR9) · [App lineup](https://www.ynab.com/our-app-lineup) · [YNAB Together](https://www.ynab.com/blog/introducing-ynab-together-for-your-shared-financial-journey) · [Great YNAB Remodel](https://www.ynab.com/whats-new/the-great-ynab-remodel) · [Better Bank Connections](https://www.ynab.com/whats-new/better-bank-connections) · [Penny Hoarder review 2026](https://www.thepennyhoarder.com/budgeting/ynab-review/) · [envelopebudgeting review](https://envelopebudgeting.com/articles/ynab-review) · [budgetpeer pricing](https://www.budgetpeer.com/blog/ynab-vs.-a-one-time-payment-budget-app-is-the-subscription-worth-it) · [Productive with Chris review](https://productivewithchris.com/app-reviews/ynab-review-2025/) · [App Store reviews](https://apps.apple.com/us/app/ynab/id1010865877?see-all=reviews) · [Trustpilot](https://www.trustpilot.com/review/ynab.com) · [NerdWallet best budget apps](https://www.nerdwallet.com/finance/learn/best-budget-apps) · [YNAB alternatives (self-hosted)](https://thefrontkit.com/blogs/ynab-alternatives-2026) · [Fortune on YNAB devotees](https://fortune.com/article/ynab-budgeting-transform-money-relationship) · [Five Questions explainer](https://www.theexuberantelephant.com/blog/ynab-budgeting-5-questions) · [Finder review](https://www.finder.com/budgeting/ynab-review) · [Experian review](https://www.experian.com/blogs/ask-experian/you-need-a-budget-app-review/)

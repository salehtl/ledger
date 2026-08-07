# Ledger closed alpha — what you are agreeing to

**Version 1.0 — 2026-08-07.** Please read this before you are given an address to forward your bank email to. It is short, and it is written to be understood rather than to protect us.

## What Ledger does

You set your bank to forward its transaction alert emails to a private address we give you. Our server reads each email, pulls out the merchant, amount and date, and your phone or browser turns that into a running picture of your spending against a 50/30/20 budget.

## The one thing that matters most

**During this alpha, your bank emails and the transactions extracted from them are stored on our server in plain text, and the operator can read them.**

The finished product is designed so that mail is encrypted the moment it arrives and the operator cannot read it. **That encryption is not built yet.** It is the next phase of work. You are joining before it exists, and you should decide on the basis of what is true today, not what is planned.

Concretely, there are four situations in which the operator can and will read your data during the alpha:

1. **Fixing a broken parser.** When our software fails to understand one of your bank's emails, the operator opens that email to see why, and re-runs it through the fixed code.
2. **Releasing held mail.** Mail from a sender you have not yet approved is held aside. Releasing it involves looking at it.
3. **Sample donation.** If you choose to donate an example email to help us support a new bank, the operator reads it. This one only happens if you opt in, per email.
4. **Measuring how well parsing works.** To know whether we are meeting our own quality bar, the operator reviews a sample of arriving mail and judges whether each item was handled correctly.

Nothing is shared with anyone outside the operator. There is no advertising, no analytics on your financial data, and no third party receives your mail content.

## What else you should know

- **There is no backup mail server yet.** If our server goes down for an extended period, your bank's mail will bounce, and Gmail will eventually switch your forwarding rule off without telling you. You may silently stop receiving transactions until you notice and re-enable it. We are working on a second server to prevent this.
- **Your passkey is the only way into your account.** If you set up Ledger with a passkey that exists on only one device and you lose that device, **your account cannot be recovered.** We strongly recommend adding a second passkey (on another device, or via a password manager that syncs) during setup. We cannot reset it for you.
- **This is not financial advice, and the numbers may be wrong.** Ledger is informational. Always check balances and budgets against your actual bank. A parser bug can mean a missing or mis-read transaction.
- **It will break sometimes.** This is an alpha with a handful of users.

## Your data, and how this ends

- **You can export everything** from inside the app at any time.
- **You can delete your account** from inside the app at any time. Deletion removes your emails, transactions, keys and address from our server. Backups age out on their own schedule, within 14 days.
- **Retention:** we keep your data only as long as you have an account.
- **At the end of the alpha**, when encryption ships, you will be given a choice: migrate your history into the encrypted system, or have it deleted. There is no third option where it silently stays readable.
- You can walk away at any time, for any reason, without explaining.

## Where this runs, and the law

The server is a single machine in Germany, operated by one person. Your financial data is subject to UAE PDPL (Federal Decree-Law 45/2021), and to GDPR if you are in the EU. The operator is the data controller. You have the right to access, export and delete your data, all of which are available in the app.

## Agreement

I have read the above. I understand that **during this alpha the operator can read my bank emails and my transaction data**, that there is no backup mail server, and that losing my only passkey means losing my account.

Name: ______________________________

Signature: __________________________   Date: ______________

---

*Countersigned by the operator, who agrees to the retention, deletion and migrate-or-delete commitments above.*

Operator: ___________________________   Date: ______________

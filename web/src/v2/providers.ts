/**
 * Forwarding instructions, per mail provider — and **nothing but instructions**.
 *
 * # Why this is a table of copy and not a table of facts
 *
 * The obvious version of this file is a per-provider description of the
 * confirmation message: sender domain, code length, link host. That would be
 * wrong on day one and stale within months, and the product would learn about it
 * from a user who could not finish setting up. Two things already contradict it:
 *
 *  - **iCloud sends no confirmation at all.** You enter the destination address
 *    and mail flows. There is no code and no message to recognise.
 *  - **Outlook is two products.** Consumer Outlook.com forwards; a work or school
 *    account on Microsoft 365 / Exchange Online blocks external auto-forwarding
 *    by default, as an anti-BEC control an administrator owns — so that user may
 *    be unable to forward whatever this screen says.
 *
 * So recognition does not live here. `verificationCode.ts` decides what a held
 * message *could* be from the server's verified signature, the user says which
 * one they were waiting for, and this file only ever answers "what do I tap".
 *
 * # `needsConfirmation` is the one field a screen ACTS on, so it is conservative
 *
 * `false` removes the confirmation-code affordance from the verification step.
 * That is a claim, so it is set only where there is evidence for it — today,
 * iCloud alone. Everything else is `true`, including {@link GENERIC}: a user who
 * is offered a code reader they did not need has lost one line of screen, and a
 * user who needed one and was not offered it is stuck.
 *
 * It is a hint about a PROVIDER'S BEHAVIOUR, never an input to trust. The choice
 * a user taps here decides which sentences render; it can never make a message
 * more trusted, and `providers.test.ts` asserts no module in the trust path can
 * even import this one.
 *
 * # The steps are deliberately allowed to be out of date, as long as they say so
 *
 * Every provider moves its settings around. The steps name the destination
 * ("the forwarding setting") as well as the path to it, and {@link GENERIC} is
 * written so that a user whose provider is not listed — or is listed wrongly —
 * still knows exactly what they are looking for.
 */

export interface Provider {
  /** Stable id. UI state only; nothing durable and nothing on the wire. */
  id: string;
  label: string;
  /**
   * Whether this provider emails a confirmation code to the destination address.
   * `false` is a claim the verification step acts on — see this file's header.
   */
  needsConfirmation: boolean;
  /** What to tap, in order. Plain sentences: they are rendered as text. */
  steps: readonly string[];
  /** Something that may stop this working, said before it is tried. */
  caveat?: string;
}

/**
 * The pickable providers.
 *
 * A short list on purpose. It is a shortcut past {@link GENERIC}, not a claim
 * about which providers work — anything with a forwarding setting works, because
 * nothing downstream knows a provider.
 */
export const PROVIDERS: readonly Provider[] = [
  {
    id: "gmail",
    label: "Gmail",
    needsConfirmation: true,
    steps: [
      "On a computer, open Gmail's Settings, then See all settings, then Forwarding and POP/IMAP.",
      "Press “Add a forwarding address” and paste the address above.",
      "Gmail emails a confirmation code to that address. The next screen lists that message so you can read the code.",
      "Back in Gmail, create a filter for your bank's sender address and tick “Forward it to” your ledger address. Forward the bank, not the whole mailbox.",
    ],
  },
  {
    id: "icloud",
    // The one `false`. Apple's own guide describes entering a forwarding address
    // and mail flowing; there is no confirmation code in that flow.
    // https://support.apple.com/guide/icloud/automatically-forward-email-mm6b1a3960/icloud
    label: "iCloud Mail",
    needsConfirmation: false,
    // The steps are the RULE, not the Forwarding switch. They used to be the
    // switch, with the caveat below retracting them one paragraph later — and a
    // user who follows numbered steps follows the numbered steps, which in that
    // version forwarded their entire personal mailbox into the inbound address.
    steps: [
      "On iCloud.com, open Mail, then its settings, then Rules.",
      "Add a rule matching your bank's sender address, with the action “Forward to” and the address above.",
      "iCloud does not send a confirmation code. Mail starts arriving once the rule is saved.",
    ],
    caveat:
      "Use a Rule, as the steps do — not iCloud's Forwarding setting, which forwards your whole mailbox rather than only your bank's mail.",
  },
  {
    id: "outlook",
    label: "Outlook.com or Hotmail",
    needsConfirmation: true,
    steps: [
      "Open Outlook on the web, then Settings, then Mail, then Forwarding.",
      "Enable forwarding, enter the address above and save.",
      "To send only your bank's mail, add a rule under Settings, then Mail, then Rules, matching your bank's sender address with the action “Forward to”.",
      "If Outlook emails a confirmation code, the next screen lists that message.",
    ],
    caveat:
      "A work or school account on Microsoft 365 may refuse to forward outside the organisation. An administrator controls that, and no Outlook setting overrides it — if forwarding is blocked, set the address with your bank directly instead.",
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    needsConfirmation: true,
    steps: [
      "Open Yahoo Mail's Settings, then More Settings, then Mailboxes, and select your account.",
      "Under Forwarding, add the address above.",
      "Yahoo emails a confirmation to that address. The next screen lists that message.",
      // Every other provider's steps say this in one form or another, and the
      // forwarding screen's closing notice used to say it once for all of them.
      // The notice is gone (it repeated the steps under the steps), so the one
      // list that lacked the line carries it now. Conditional, because Yahoo's
      // own forwarding setting is mailbox-wide and this file does not claim to
      // know what any provider can filter on — see the header.
      "If Yahoo can forward only the mail matching a rule, match your bank's sender address — forward the bank, not the whole mailbox.",
    ],
  },
  {
    id: "proton",
    label: "Proton Mail",
    needsConfirmation: true,
    steps: [
      "Open Proton Mail's settings, then Forward emails, and add the address above.",
      "Proton emails a confirmation to that address. The next screen lists that message.",
      "To send only your bank's mail, add a filter matching your bank's sender address instead of forwarding everything.",
    ],
    caveat: "Forwarding to an address outside Proton is a paid-plan feature.",
  },
];

/**
 * Everything else — and the honest default rather than a fallback nobody read.
 *
 * It names the destination rather than a path, because the path is what differs
 * and the destination is what does not: every provider that can forward has a
 * setting called something close to "forwarding".
 */
export const GENERIC: Provider = {
  id: "other",
  label: "Another provider",
  needsConfirmation: true,
  steps: [
    "Find the forwarding or auto-forward setting in your mail provider's settings, and add the address above.",
    "If your provider can forward only mail matching a rule, match your bank's sender address — forward the bank, not the whole mailbox.",
    "If your provider emails a confirmation code, the next screen lists that message so you can read the code.",
  ],
};

/** The provider with this id, or {@link GENERIC}. Never throws, never guesses. */
export function providerFor(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? GENERIC;
}

/**
 * The development-only affordance on the welcome screen.
 *
 * # It is not a bypass, and it deliberately cannot be one
 *
 * The native app's panel of this name signed in as `dev:<subject>` against
 * `ledgerd serve --dev-auth`, which installs `auth.NewDevVerifier` for both
 * IdPs. **That seam does not exist for passkeys.** `api.NewServer`'s `DevAuth`
 * block replaces `s.Verifiers` — the Apple/Google ID-token verifiers — and
 * nothing touches `s.Passkeys`, which is a concrete `*auth.Passkeys` running
 * go-webauthn against real signatures on every one of the six routes. There is
 * no flag, and no request a page can make, that gets a session out of those
 * routes without an authenticator actually signing a challenge.
 *
 * So a panel that claimed to sign in without one would be lying, and a panel
 * that fabricated a credential would be refused by the server. What is left, and
 * what this is, is the two things that genuinely remove the friction:
 *
 *  1. **Say where the authenticator comes from.** Every desktop browser ships a
 *     software one for exactly this: Chrome's DevTools → WebAuthn → *Enable
 *     virtual authenticator environment* creates a resident-key-capable
 *     authenticator that satisfies both ceremonies, including the discoverable
 *     login this product's sign-in depends on. Nobody needs hardware; they need
 *     to be told the panel is there.
 *  2. **Prefill the invite code**, so a local loop is one tap rather than a
 *     round trip to a terminal to re-read a code.
 *
 * # The gate
 *
 * One `import.meta.env.DEV` read, at the call site in `Welcome.tsx`. Vite
 * replaces that identifier with `false` in a production build and folds the
 * branch away, after which nothing references this module and it is dropped from
 * the bundle. {@link DEV_PANEL_MARKER} is on the glass so "is the bypass panel
 * in this build" and "can I read this string" are one question — the same trick
 * the native panel used, and the same reason: a claim about a bundler is
 * measured, not asserted.
 */

import { Button } from "../../components/ui/Button";
import { Notice } from "./Shell";

/** The string a production-bundle grep looks for. Rendered, so it is checkable. */
const DEV_PANEL_MARKER = "ledger-dev-onboarding-panel";

/** The code a local `ledgerd` is usually seeded with. A convenience, not a secret. */
const DEV_INVITE_CODE = "DEV-INVITE";

export function DevSignInPanel({ disabled, onPrefill }: { disabled: boolean; onPrefill: (code: string) => void }) {
  return (
    <div data-testid="dev-sign-in-panel" className="mt-2">
      <Notice title="Developer aid — development builds only">
        <p>
          This panel cannot sign anyone in. The passkey routes verify real signatures and have no development
          seam, so a session here needs an authenticator like anywhere else.
        </p>
        <p>
          On a desktop browser you already have one: open DevTools, find <span className="font-mono">WebAuthn</span>,
          and turn on <span className="font-mono">Enable virtual authenticator environment</span> with resident keys
          allowed. Both the sign-up and the username-less sign-in then work with no hardware.
        </p>
        <Button variant="secondary" disabled={disabled} onClick={() => onPrefill(DEV_INVITE_CODE)}>
          Prefill the dev invite code
        </Button>
        <p className="text-xs text-muted">
          Present only in a development build: <span className="font-mono">{DEV_PANEL_MARKER}</span>
        </p>
      </Notice>
    </div>
  );
}

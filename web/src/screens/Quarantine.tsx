/**
 * Held mail, and the one decision it asks for.
 *
 * # The security requirement this screen exists to satisfy
 *
 * The inbound address is an unauthenticated write endpoint into a financial
 * ledger. Anyone who learns it can send it mail. Trusting a sender authorises
 * every future message from that origin to become transactions in the user's
 * own log — so spec §3.2 is specific: the trust decision must be made from the
 * **verified signing domain**, or from a prominent unauthenticated state, and
 * **never from attacker-rendered content**.
 *
 * That is enforced on both sides and this screen is the second of them:
 *
 *  - The API does not send the subject, the display name or any part of the body
 *    (`internal/v2/api/quarantine.go`: "The response carries the VERIFIED signing
 *    domain, the attested inner origin and an explicit attestation state — never
 *    the message's subject, its display name, or any part of its body"). The one
 *    exception, `?include_blob=1`, is onboarding's confirmation-code step and is
 *    not requested here.
 *  - Everything rendered below comes from `trustBasis(item)` — `attested`,
 *    `attested_by`, `inner_domain`, `outer_domain`, `dkim`, `arc` — and every one
 *    of those is a *server* judgement about a signature, not a claim the message
 *    made about itself. `attested` is decoded as `=== true`, so a field this
 *    build failed to read can never read as verified.
 *
 * An unattested item is not merely un-actionable, it is **stated**: the row and
 * the sheet both say "Unauthenticated" in the danger tone, the button says
 * "Cannot trust unauthenticated mail" and is disabled, and `trustRequest`
 * returns `null` so there is no code path that could send a confirmation for it
 * even if the button were somehow pressed. The copy is the native screen's,
 * kept — it was written for exactly this.
 *
 * # The forwarder is a refusal the server makes, not one this screen hides
 *
 * A user's mail provider signs the forwarding hop, so `google.com` is a
 * perfectly verified origin — and allowlisting it would trust every message that
 * passes through the mailbox. The server answers that with `409
 * forwarder_domain` and words the user can act on; the screen shows them
 * verbatim rather than second-guessing which domains are forwarders.
 *
 * # `remaining` is not a detail
 *
 * One confirmation re-ingests a bounded batch (`defaultMaxReingestPerConfirm`,
 * 500). `ConfirmSenderResponse.Reingest.Remaining` is what it did NOT attempt,
 * and the confirmed item has already left the lane — so if this screen dropped
 * the number, mail the user had just vouched for would sit held until it
 * expired: announced, per §2, but gone. It is surfaced as its own notice with
 * its own button, which outlives the row that produced it.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@ledger/client/net/client";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Dialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/EmptyState";
import { Pressable } from "../components/ui/Pressable";
import { PixelSpinner } from "../components/ui/PixelSpinner";
import { CheckCircle2 } from "../components/ui/PixelIcon";
import { useV2 } from "../v2/BootGate";
import {
  CONFIRM_CONFLICT_COPY,
  confirmSender,
  deletionNotice,
  readQuarantine,
  trustBasis,
  trustRequest,
  type QuarantineItem,
  type TokenSource,
  type TrustScope,
} from "../v2/onboardingIO";

export interface QuarantineProps {
  /** The bearer-token source. Defaults to the gate's client. */
  client?: TokenSource;
  /** Pulls the log once a confirmation has released mail into it. */
  sync?: () => Promise<void>;
  server?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Partial {
  domain: string;
  scope: TrustScope;
  remaining: number;
}

export function Quarantine({ client: injected, sync, server, fetch: doFetch, now = Date.now }: QuarantineProps) {
  const runtime = useV2();
  const client = injected ?? runtime?.handle.client ?? null;

  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<QuarantineItem | null>(null);
  const [partial, setPartial] = useState<Partial | null>(null);

  const io = { ...(server === undefined ? {} : { server }), ...(doFetch === undefined ? {} : { fetch: doFetch }) };

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    setBusy(true);
    try {
      const page = await readQuarantine(client, {}, io);
      setItems(page.items);
    } catch {
      setMessage("Could not load held mail. Pull down to try again.");
    } finally {
      setBusy(false);
    }
    // `io` is rebuilt each render by design (it is two optional overrides); the
    // identities that matter are the ones below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, server, doFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = useCallback(
    async (domain: string, scope: TrustScope): Promise<void> => {
      if (client === null) return;
      setBusy(true);
      setMessage("");
      try {
        const result = await confirmSender(client, domain, scope, io);
        const left = result.reingest?.remaining ?? 0;
        setPartial(left > 0 ? { domain: result.domain, scope, remaining: left } : null);
        setMessage(
          result.reingest === null
            ? `${result.domain} is trusted. This server cannot re-read held mail, so nothing was filed yet.`
            : result.reingest.incomplete
              ? "ledger filed part of the mail held for that sender and then hit an error. The rest is still held " +
                "and still safe — try filing it again."
              : `${result.domain} is trusted. ${result.reingest.appended} transaction` +
                `${result.reingest.appended === 1 ? "" : "s"} filed` +
                `${result.reingest.failed > 0 ? `, ${result.reingest.failed} could not be read` : ""}.`,
        );
        setOpen(null);
        // The mail is in the log on the server; it reaches this device's ledger
        // only on a pull, so a screen that skipped this would say "filed" over a
        // ledger that does not hold it yet.
        try {
          await sync?.();
        } catch {
          // A failed pull is not a failed confirmation. The next sync collects it.
        }
        await load();
      } catch (error) {
        const code = error instanceof ApiError ? error.code : "";
        setMessage(CONFIRM_CONFLICT_COPY[code] ?? "Could not trust this sender. Try again.");
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, server, doFetch, sync, load],
  );

  if (client === null) {
    return (
      <EmptyState
        title="You're not signed in"
        hint="Held mail belongs to an account. Sign in to see what is waiting."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-muted">
        These messages stay outside your ledger until you trust a verified sender. Nothing here has been read into
        your totals.
      </p>

      {message !== "" && (
        <p role="alert" data-testid="quarantine-message" className="text-sm leading-relaxed text-fg">
          {message}
        </p>
      )}

      {partial !== null && (
        <Card className="border-bad">
          <h2 className="text-sm font-semibold text-bad">Some held mail is still waiting</h2>
          <p className="mt-1 text-sm text-muted">
            ledger files a bounded batch per confirmation, and {partial.remaining}{" "}
            {partial.remaining === 1 ? "message" : "messages"} from <span className="font-mono">{partial.domain}</span>{" "}
            {partial.remaining === 1 ? "was" : "were"} not reached this time. Nothing is lost — it is still held — but
            it will not file itself.
          </p>
          <Button
            variant="primary"
            className="mt-3"
            disabled={busy}
            onClick={() => void confirm(partial.domain, partial.scope)}
          >
            File the rest
          </Button>
        </Card>
      )}

      {items.map((item) => {
        const basis = trustBasis(item);
        const expiry = deletionNotice(item, now());
        return (
          <Pressable
            key={item.id}
            data-testid={`quarantine-row-${item.id}`}
            onClick={() => setOpen(item)}
            className="min-h-11 w-full rounded-[var(--radius)] border border-border bg-surface p-4 text-left"
          >
            {/* The verified signing domain, or the unauthenticated state — and
                nothing the sender wrote. */}
            <p
              className={`font-mono text-base font-semibold ${basis.authenticated ? "text-fg" : "text-bad"}`}
              data-testid={`quarantine-basis-${item.id}`}
            >
              {basis.label}
            </p>
            <p className="mt-1 text-xs text-muted">Verification: {basis.source}</p>
            <p className="text-xs text-muted tnum">Arrived {item.receivedAt.slice(0, 10)}</p>
            {expiry !== null && <p className="mt-1 text-xs font-semibold text-bad">{expiry}</p>}
          </Pressable>
        );
      })}

      {!busy && items.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-8 py-12 text-center">
          <CheckCircle2 size={40} className="text-fg" />
          <h2 className="text-lg font-semibold text-fg">Nothing is being held</h2>
          <p className="text-sm text-muted">Mail from senders you have trusted goes straight into your ledger.</p>
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-3 text-muted" role="status">
          <PixelSpinner size={12} />
          <span className="text-sm">Checking held mail…</span>
        </div>
      )}

      {open !== null && <TrustSheet item={open} busy={busy} onClose={() => setOpen(null)} onConfirm={confirm} />}
    </div>
  );
}

/**
 * The trust decision itself.
 *
 * Everything on it is a verified fact or an explicit absence of one. There is no
 * subject line, no display name and no preview, because a sheet that rendered
 * them would be asking the user to authenticate the sender using text the sender
 * wrote — which is precisely the attack §3.2 names.
 */
function TrustSheet({
  item,
  busy,
  onClose,
  onConfirm,
}: {
  item: QuarantineItem;
  busy: boolean;
  onClose: () => void;
  onConfirm: (domain: string, scope: TrustScope) => Promise<void>;
}) {
  const basis = trustBasis(item);
  const request = trustRequest(item);
  return (
    <Dialog title={basis.authenticated ? "Trust this sender?" : "This mail is unauthenticated"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted">
            {basis.authenticated ? "Verified signing domain" : "Signing domain"}
          </p>
          <p
            data-testid="trust-basis"
            className={`font-mono text-2xl font-semibold break-all ${basis.authenticated ? "text-fg" : "text-bad"}`}
          >
            {basis.label}
          </p>
          <p className="mt-1 text-sm text-muted">Verification: {basis.source}</p>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-xs text-muted">
          <div>
            <dt className="uppercase tracking-[0.14em]">DKIM</dt>
            <dd className="font-mono text-fg">{item.dkim === "" ? "none" : item.dkim}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-[0.14em]">ARC</dt>
            <dd className="font-mono text-fg">{item.arc === "" ? "none" : item.arc}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-[0.14em]">Outer origin</dt>
            <dd className="font-mono text-fg break-all">{item.outerDomain === "" ? "—" : item.outerDomain}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-[0.14em]">Inner origin</dt>
            <dd className="font-mono text-fg break-all">{item.innerDomain === "" ? "—" : item.innerDomain}</dd>
          </div>
        </dl>

        {basis.authenticated ? (
          <p className="text-sm leading-relaxed text-muted">
            Trusting this domain lets every future message it signs become transactions in your ledger. Only do it
            for a sender you recognise — your bank, not the service that forwards your mail.
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-bad">
            No message held for this account carries a verified signature from this sender, so there is nothing to
            trust. Mail that cannot be verified stays held.
          </p>
        )}

        <Button
          variant={request === null ? "secondary" : "primary"}
          disabled={request === null || busy}
          onClick={() => {
            if (request !== null) void onConfirm(request.domain, request.scope);
          }}
        >
          {request === null ? "Cannot trust unauthenticated mail" : "Trust this sender"}
        </Button>
      </div>
    </Dialog>
  );
}

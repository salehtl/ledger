/**
 * Onboarding step 5: Google's held confirmation, and then the first real bank
 * email.
 *
 * One screen for two things because the machine has one slot for them
 * (`SCREEN_FOR` maps `forwarding_configured` to `"verification"` and
 * `first_mail_confirmed` straight on to the currency picker), and because in
 * practice they are one wait: the user sets the forward, Google's confirmation
 * lands within seconds, and the bank's first alert lands whenever the bank
 * feels like it.
 *
 * # Everything here is read out of the QUARANTINE lane, and that is by design
 *
 * Plan Decision 7. Gmail's confirmation is signed by `google.com`, spec 3.2
 * forbids ever promoting a forwarder domain, so the message that onboarding
 * depends on is one the product will never trust. It is held forever and read
 * in place. {@link QUARANTINE_HELD} is the wording for that, and it says "held
 * on purpose" before it says anything else, because the alternative is a new
 * user's first impression being a fault.
 *
 * # What may be rendered as trusted, and what may not
 *
 * The bank half shows `trustBasis(item)` - the VERIFIED signing domain, or a
 * prominent unauthenticated state - and never the subject, the display name or
 * any part of the body. The API does not even send those fields for exactly
 * this reason. The Google half does render body text, because it has to, and it
 * is labelled as raw and untrusted, capped, and passed through React Native's
 * `<Text>`, which interprets no markup. The only two things lifted out of it
 * and offered as actions are a nine-digit run and a URL whose host is a literal
 * in the pattern - see `lib/verificationCode.ts`.
 *
 * # Advancing is MEASURED, not inferred
 *
 * `first_mail_confirmed` is a fact about the log: a genuine bank email became a
 * transaction. A `200` from `POST /api/v1/quarantine/confirm` is not that fact
 * - it can re-ingest nothing at all - so after a confirmation this screen
 * re-reads {@link VerificationScreenProps.firstMailAt}, which folds the log,
 * and advances only if that answers with a timestamp. Otherwise it says what
 * happened and stays put.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError } from "@ledger/client/net/client.ts";

import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { QUARANTINE_HELD } from "../../lib/onboarding.ts";
import { CONFLICT_COPY, trustBasis, trustRequest, type QuarantineItem } from "../../lib/quarantine.ts";
import {
  heldBody,
  isForwarderConfirmation,
  NO_CODE_COPY,
  scanForCode,
  UNTRUSTED_BODY_LABEL,
  type CodeScan,
} from "../../lib/verificationCode.ts";
import type { QuarantineSource } from "../quarantine/source.ts";

/**
 * How often the lane is re-read while the user waits.
 *
 * There is no push for held mail (`api/quarantine.go`: "Nothing here pushes"),
 * so a poll is the only way this screen learns anything. 15 s is chosen against
 * the wait it covers - a Gmail confirmation arrives in seconds and a bank alert
 * in minutes to hours - and the request is a page of held mail, not a sync.
 */
export const VERIFICATION_POLL_MS = 15_000;

export interface VerificationScreenProps {
  source: QuarantineSource;
  copy: (text: string) => Promise<void>;
  openLink: (url: string) => Promise<void>;
  /** Folds the log. The ONLY thing that may say the first mail is confirmed. */
  firstMailAt: () => string | null;
  onConfirmed(at: string): void;
  pollMs?: number;
}

export function VerificationScreen({
  source,
  copy,
  openLink,
  firstMailAt,
  onConfirmed,
  pollMs = VERIFICATION_POLL_MS,
}: VerificationScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const live = useRef(true);

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const page = await source.list({}, { includeBlob: true });
      if (live.current) setItems(page.items);
    } catch {
      if (live.current) setMessage("Could not check for held mail. ledger will keep trying.");
    } finally {
      if (live.current) setBusy(false);
    }
  }, [source]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = setInterval(() => { void load(); }, pollMs);
    return () => { clearInterval(timer); };
  }, [load, pollMs]);

  const forwarder = items.find(isForwarderConfirmation) ?? null;
  const banks = items.filter((item) => !isForwarderConfirmation(item));
  /**
   * Memoized on the blob, not recomputed per render.
   *
   * This screen re-renders on every 15 s poll and on every keystroke-free state
   * change, and the work behind it is a full MIME normalize of a message that
   * may be a megabyte. Phase 0's >500 MB device freeze was partly unguarded
   * repeated passes over large bodies; there is no reason for this one to run
   * more than once per distinct message.
   */
  const scan: CodeScan | null = useMemo(
    () =>
      forwarder === null || forwarder.blob === undefined
        ? null
        : scanForCode(heldBody(forwarder.blob, forwarder.receivedAt).text),
    [forwarder?.blob, forwarder?.receivedAt],
  );

  const onCopyCode = async (code: string) => {
    try {
      await copy(code);
      setCopied(true);
    } catch {
      setMessage("This device would not let ledger use the clipboard. The code above can be selected by hand.");
    }
  };

  const confirm = async (item: QuarantineItem) => {
    const request = trustRequest(item);
    if (request === null) return;
    setBusy(true);
    setMessage("");
    try {
      await source.confirm(request.domain, request.scope);
      const at = firstMailAt();
      if (at === null) {
        // A confirmation that re-ingested nothing. Said plainly rather than
        // treated as progress: the milestone is a transaction in the log, and
        // there is not one.
        setMessage(`${request.domain} is trusted, but no transaction came out of the mail held for it yet. ledger will keep watching.`);
        await load();
        return;
      }
      onConfirmed(at);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      setMessage(code === "forwarder_domain" || code === "origin_unproven" ? CONFLICT_COPY[code] : "Could not trust this sender. Try again.");
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const card = {
    gap: t.space.sm,
    padding: t.space.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.hairline,
    backgroundColor: t.colors.surface,
  } as const;

  return (
    <ScrollView
      testID="onboarding-verification"
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.xl,
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.lg,
        flexGrow: 1,
      }}
    >
      <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>
        {QUARANTINE_HELD.title}
      </Text>
      <Text style={[t.type.body, { color: t.colors.text }]}>{QUARANTINE_HELD.body}</Text>

      {message !== "" && (
        <Text testID="verification-message" accessibilityRole="alert" style={[t.type.body, { color: t.colors.text }]}>
          {message}
        </Text>
      )}

      {/* ---- Google's confirmation ---- */}
      {forwarder === null ? (
        <View testID="verification-waiting" style={card}>
          <Text style={[t.type.heading, { color: t.colors.text }]}>Waiting for Google's confirmation</Text>
          <Text style={[t.type.body, { color: t.colors.textMuted }]}>
            When you add the forward, Google emails a code to your ledger address. It usually arrives within a
            minute, and it will appear here.
          </Text>
        </View>
      ) : (
        <View testID="verification-forwarder" style={card}>
          <Text style={[t.type.heading, { color: t.colors.text }]}>From {forwarder.outerDomain}</Text>
          {scan === null ? (
            <Text testID="verification-no-body" style={[t.type.body, { color: t.colors.text }]}>
              This message is held but its contents were not sent to this device. Open it from held mail in settings
              once you are through setup.
            </Text>
          ) : scan.code !== null ? (
            <>
              <Text
                testID="verification-code"
                selectable
                accessibilityLabel={`Confirmation code ${scan.code}`}
                style={[t.type.address, { color: t.colors.text }]}
              >
                {scan.code}
              </Text>
              <Pressable
                testID="verification-copy-code"
                accessibilityRole="button"
                accessibilityLabel="Copy confirmation code"
                onPress={() => void onCopyCode(scan.code as string)}
                style={({ pressed }) => ({
                  minHeight: TOUCH_TARGET_MIN,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: t.radius.md,
                  backgroundColor: t.colors.text,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={[t.type.heading, { color: t.colors.bg }]}>{copied ? "Copied" : "Copy code"}</Text>
              </Pressable>
              <Text style={[t.type.label, { color: t.colors.textMuted }]}>
                Paste this into the confirmation box in your mail provider's forwarding settings.
              </Text>
            </>
          ) : (
            <>
              <Text testID="verification-no-code" style={[t.type.body, { color: t.colors.text }]}>{NO_CODE_COPY}</Text>
              <Text style={[t.type.label, { color: t.colors.textMuted }]}>{UNTRUSTED_BODY_LABEL}</Text>
              <Text testID="verification-raw-body" selectable style={[t.type.mono, { color: t.colors.textMuted }]}>
                {scan.body}
              </Text>
            </>
          )}
          {scan !== null && scan.link !== null && (
            <Pressable
              testID="verification-open-link"
              accessibilityRole="link"
              accessibilityLabel="Open Google's confirmation link"
              onPress={() => void openLink(scan.link as string)}
              style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
            >
              <Text style={[t.type.body, { color: t.colors.accent }]}>Open the confirmation link on mail-settings.google.com</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* ---- The first real bank email ---- */}
      <Text accessibilityRole="header" style={[t.type.heading, { color: t.colors.text }]}>
        Your first bank email
      </Text>
      {banks.length === 0 ? (
        <View testID="verification-no-bank-mail" style={card}>
          <Text style={[t.type.body, { color: t.colors.textMuted }]}>
            Nothing from a bank has arrived yet. This step finishes on its own when one does, so you can leave the
            app open or come back later.
          </Text>
        </View>
      ) : (
        banks.map((item) => {
          const basis = trustBasis(item);
          return (
            <View key={item.id} testID={`verification-bank-${item.id}`} style={card}>
              <Text
                testID={`verification-bank-basis-${item.id}`}
                style={[t.type.heading, { color: basis.authenticated ? t.colors.text : t.colors.danger }]}
              >
                {basis.label}
              </Text>
              <Text style={[t.type.label, { color: t.colors.textMuted }]}>Verification: {basis.source}</Text>
              <Text style={[t.type.label, { color: t.colors.textMuted }]}>DKIM: {item.dkim} - ARC: {item.arc}</Text>
              <Pressable
                testID={`verification-trust-${item.id}`}
                accessibilityRole="button"
                disabled={!basis.authenticated || busy}
                onPress={() => void confirm(item)}
                style={({ pressed }) => ({
                  minHeight: TOUCH_TARGET_MIN,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: t.radius.md,
                  backgroundColor: basis.authenticated ? t.colors.text : t.colors.hairline,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={[t.type.heading, { color: basis.authenticated ? t.colors.bg : t.colors.textMuted }]}>
                  {basis.authenticated ? `This is my bank - file its mail` : "Cannot trust unauthenticated mail"}
                </Text>
              </Pressable>
            </View>
          );
        })
      )}

      <Pressable
        testID="verification-refresh"
        accessibilityRole="button"
        accessibilityLabel="Check now"
        disabled={busy}
        onPress={() => void load()}
        style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
      >
        <Text style={[t.type.body, { color: t.colors.accent, opacity: busy ? 0.5 : 1 }]}>Check now</Text>
      </Pressable>
      {busy && <ActivityIndicator accessibilityLabel="Checking held mail" color={t.colors.accent} />}
    </ScrollView>
  );
}

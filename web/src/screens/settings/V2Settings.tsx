/**
 * Settings, in v2: the facts about this account, and the controls that are not
 * reachable anywhere else.
 *
 * # This is a NEW screen, and `screens/Settings.tsx` is untouched
 *
 * v1's Settings hub reads `/api/budget`, `/api/settings`, `/api/categories`,
 * `/api/rules`, `/api/rates`, `/api/health`, `/api/accounts`, `/api/projects`,
 * `/api/scheduled` and `/api/settings/notifications`. `ledgerd` serves none of
 * them, and every one of those queries would sit `isPending` forever behind a
 * row that looked like it was loading. It is unrouted rather than rewritten
 * because most of those pages come back the moment their data grows a
 * projection; deleting them would throw away work that is only early.
 *
 * # Why "add another passkey" is the most important control on this screen
 *
 * There is no account recovery and there cannot be one — the server holds no
 * password, no recovery address and no second factor, and spec Decision 10
 * refused a recovery phrase that recovers nothing. A user whose only credential
 * lives on one handset loses every record in the account when that handset does,
 * and the operator cannot help. `passkeyAdd.ts` has existed since Task 4 and
 * nothing called it, while Task 7's onboarding already told people they could
 * "add a passkey later from Settings". This is that promise being made true.
 *
 * # Why the sync row exists at all
 *
 * The projection is the data. It only moves when a sync writes it, and every
 * screen in the app reads it silently — so without this row there is no way at
 * all to tell "nothing has happened" from "nothing is working". It carries the
 * halt reason for the same reason `BootGate` gives a halt the whole screen: an
 * engine that has stopped standing behind its records must never render as idle.
 *
 * # The home currency is shown and NOT offered
 *
 * Spec §3.7: log state, set once, no in-product way to change it. A row with a
 * chevron on it would be a lie, so this one has neither a chevron nor a tap
 * target — just the code and the sentence saying why that is all there is.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { Pressable } from "../../components/ui/Pressable";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { ChevronRight } from "../../components/ui/PixelIcon";
import { sinceLabel } from "../../lib/sinceLabel";
import { readAddress } from "../../v2/address";
import { useV2OrThrow } from "../../v2/BootGate";
import { ADD_PASSKEY_COPY, RECOVERY_WARNING } from "../../v2/onboarding";
import { addPasskey } from "../../v2/passkeyAdd";
import { passkeyFailureCopy } from "../../v2/passkeyCopy";
import { BankPicker } from "../../components/BankPicker";
import { BudgetSplitPicker, completeSplit, type BudgetSplitDraft } from "../../components/BudgetSplitPicker";
import { MonthlyTotalField } from "../../components/MonthlyTotalField";
import { formatMoney, minorToDraft, parseMinorDraft } from "../../lib/minorMoney";
import { activeBanks, bankDeclaredOps } from "../../v2/sources/banks";
import { isDeclarableBankID } from "../../v2/bank";
import { readSupportedBanks, type SupportedBank } from "../../v2/onboardingIO";
import { budgetSplitOps, DEFAULT_BUDGET_SPLIT } from "../../v2/sources/budget";
import {
  invalidateAfterSync,
  useBanksSource,
  useBudgetSnapshot,
  useBudgetSource,
  useCategoryChoices,
  useDeclaredBanks,
  useHomeCurrency,
  useReviewSource,
  useTxnSource,
  v2Keys,
} from "../../v2/queries";
import { V2CategoriesPanel } from "./V2CategoriesPanel";
import { useWriter, type Writer } from "../../v2/writer";
import { isPasskeyError, type V2Handle } from "../../v2/session";
import type { EnrolmentRequest, KeyHistoryEntry } from "../../v2/deviceEnrolment";
import { ApproveDevicePanel } from "./ApproveDevicePanel";

export interface V2SettingsProps {
  /** Opens the held-mail drill-in. Absent hides the row. */
  onOpenQuarantine?: () => void;
  /** Test seam. Defaults to the real add-passkey ceremony. */
  addAnotherPasskey?: (handle: V2Handle) => Promise<string>;
  /** Test seam. Defaults to `GET /api/v1/address`. */
  address?: (handle: V2Handle) => Promise<string | null>;
  /** Test seam. Defaults to `GET /api/v1/templates`, collapsed per bank. */
  templates?: (handle: V2Handle) => Promise<SupportedBank[]>;
  /** Test seam. Defaults to {@link signOutAndReload}. */
  signOut?: (handle: V2Handle) => Promise<void>;
  /** Test seam. Defaults to the Clipboard API. */
  copy?: (text: string) => Promise<void>;
  /** Test seam. Defaults to `GET /api/v1/key-history`. */
  keyHistory?: (handle: V2Handle) => Promise<KeyHistoryEntry[]>;
  /** Test seam. Defaults to signing the peer's registration with this device's key. */
  approve?: (handle: V2Handle, request: EnrolmentRequest) => Promise<void>;
  /** Test seam: a writer that records what the screen would append. */
  writer?: Writer;
  /** Test seam. */
  now?: () => number;
}

/**
 * Signing out, and then a reload.
 *
 * The reload is structural, not cosmetic: the handle, the engine and the outbox
 * are all memoised for the tab's lifetime and all three are bound to a session
 * that no longer exists. `wipeLocalData` reloads for the same reason.
 *
 * Nothing local is DELETED, which is the difference between this and a wipe. The
 * projection and the op log stay on the device; signing back in with the same
 * account adopts them, and signing in with a different one reaches Welcome's
 * `account_mismatch` screen, which is where the decision to erase belongs.
 */
export async function signOutAndReload(handle: V2Handle): Promise<void> {
  await handle.signOut();
  if (typeof location !== "undefined" && typeof location.reload === "function") location.reload();
}

async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    throw new Error("this browser has no clipboard access");
  }
  await navigator.clipboard.writeText(text);
}

const PHASE_LABEL: Record<string, string> = {
  idle: "Up to date",
  pulling: "Fetching new records…",
  pushing: "Sending your changes…",
  folding: "Reading your records…",
  projecting: "Rebuilding your ledger…",
};

export function V2Settings({
  onOpenQuarantine,
  addAnotherPasskey = (h) => addPasskey({ client: h.client }),
  address = (h) => readAddress(h.client),
  templates = (h) => readSupportedBanks(h.client),
  signOut = signOutAndReload,
  copy = writeClipboard,
  keyHistory = (h) => h.keyHistory(),
  approve = (h, request) => h.approveDevice(request),
  writer: injectedWriter,
  now = Date.now,
}: V2SettingsProps) {
  const { handle, sync, coordinator, facts } = useV2OrThrow();
  const qc = useQueryClient();
  const homeCurrency = useHomeCurrency(useTxnSource()) ?? facts.homeCurrency;
  const writer = useWriter(injectedWriter);
  const budget = useBudgetSnapshot(useBudgetSource());

  // The invalidation is not optional: the projection is the data, so a sync
  // that nothing invalidated moves rows the tree never re-reads. Same pairing
  // the shell's pull-to-refresh makes.
  const syncNow = useCallback(async () => {
    await sync.run("refresh");
    await invalidateAfterSync(qc);
  }, [sync, qc]);

  // Server truth, not the fact. `onboarding.ts` is explicit that the cached
  // address is a RESUME HINT: an address that has since been rotated would be
  // printed here as the one to forward to, and the mail would go nowhere.
  // The fact is the placeholder while the read is in flight, never the answer.
  const inbound = useQuery({
    queryKey: v2Keys.address(),
    queryFn: () => address(handle),
    staleTime: 60_000,
  });
  const shownAddress = inbound.data ?? (inbound.isPending ? facts.inboundAddress : null);

  const [copied, setCopied] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const [passkeyNote, setPasskeyNote] = useState<string | null>(null);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  // The definitions, not the categories the user has USED: this screen manages
  // the set on offer, and a retired one has to stay visible here so it can be
  // brought back.
  const categoryDefs = useCategoryChoices(useReviewSource()).data?.categoryDefs ?? [];

  // Bound here rather than inline in the JSX so the panel's fetch effect, which
  // depends on the identity of its loader, runs once per opening instead of on
  // every render of this screen.
  const loadKeyHistory = useCallback(() => keyHistory(handle), [keyHistory, handle]);
  const approveDevice = useCallback(
    (request: EnrolmentRequest) => approve(handle, request),
    [approve, handle],
  );

  const onCopy = useCallback(
    async (value: string): Promise<void> => {
      try {
        await copy(value);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    },
    [copy],
  );

  /**
   * The add ceremony. A failure here NEVER blocks anything — the account is
   * fine and the existing passkey still works — so every arm says so, and the
   * button stays live. A dismissed prompt in particular is not an error: the
   * user decided not to, and being scolded for it is how a person learns to
   * ignore this row.
   */
  const addPasskeyNow = useCallback(async (): Promise<void> => {
    setAdding(true);
    setPasskeyNote(null);
    try {
      await addAnotherPasskey(handle);
      // NOT `ADD_PASSKEY_COPY.done` ("Second passkey added."). That constant is
      // true on the onboarding screen, where it can only ever be the second;
      // here the row can be used a third and fourth time. And there is no route
      // to list enrolled credentials — `passkey.go` exposes `add/{begin,finish}`
      // and nothing that enumerates — so this must not imply a count it cannot
      // check. It names the one place that does know instead.
      setPasskeyNote(
        "A new passkey was added to this account. ledger cannot show you a list of them — check your " +
          "authenticator or password manager to see every passkey you hold.",
      );
    } catch (error) {
      const kind = isPasskeyError(error) ? error.passkeyKind : "unavailable";
      const copyFor = passkeyFailureCopy(kind);
      setPasskeyNote(`${copyFor.title}. ${copyFor.body}`);
    } finally {
      setAdding(false);
    }
  }, [addAnotherPasskey, handle]);

  const doSignOut = useCallback(async (): Promise<void> => {
    setSigningOut(true);
    try {
      await signOut(handle);
    } finally {
      setSigningOut(false);
      setSignOutOpen(false);
    }
  }, [signOut, handle]);

  /**
   * Three failure-shaped states, not two, and conflating the last two is how
   * this row announced its own subject as health.
   *
   *  - `halted !== null` — the engine has LATCHED a verdict. It refuses every
   *    later sync until `resume()`, so no retry is offered.
   *  - `phase === "halted"` with no reason — a run **stopped**. `SyncEngine.run`
   *    publishes `halted` and rethrows for every transport failure,
   *    `ChainBreakError` and `ProtocolError` alike (`engine.ts:405`), and it
   *    leaves the phase there until the next run starts. `useSync` deliberately
   *    classifies an offline throw as a NON-fault — being unreachable is not an
   *    integrity verdict — so no `HaltWall` covers this and nothing else on the
   *    glass says it happened. This row is it.
   *  - idle — genuinely up to date.
   *
   * The middle one used to fall through to the last, printing "Up to date" over
   * a sync that had just failed. A retry there can plainly work, so "Sync now"
   * stays: the engine has latched nothing, and coming back online is the fix.
   */
  const halted = coordinator.haltReason;
  const phase = sync.progress.phase;
  const busy = phase !== "idle" && phase !== "halted";
  const stopped = phase === "halted" && halted === null;

  /**
   * Re-read on a timer, not once at render.
   *
   * Settings is a screen somebody leaves open, and a "Last synced 2 minutes
   * ago" frozen at the moment of mount is the same class of untruth as the
   * branch above: a sentence the code stops making true the instant it is
   * painted. 30 s against a label whose finest unit is a minute means it is
   * never more than half a unit stale, and there is nothing here to watch tick.
   */
  /**
   * The plan being typed, seeded from the projection once it has been read.
   *
   * A draft rather than a controlled read of the snapshot, because the fields
   * have to be emptiable to be retyped (`NumberField`'s whole reason for
   * existing), and an empty field is `null` — which is not a plan and cannot be
   * saved. `seededSplit` guards the seeding so a sync landing mid-edit cannot
   * overwrite what the user is typing.
   */
  const [splitDraft, setSplitDraft] = useState<BudgetSplitDraft>(DEFAULT_BUDGET_SPLIT);
  // The monthly total's TEXT, seeded from the projection alongside the
  // percentages. `minorToDraft` and not `formatMinor`: the field's own parser
  // refuses a grouping comma, so a seeded "12,000.00" would be a value this
  // screen calls unreadable the moment it is displayed.
  const [totalText, setTotalText] = useState("");
  const [seededSplit, setSeededSplit] = useState(false);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitNote, setSplitNote] = useState<string | null>(null);
  const heldSplit = budget.data?.split;
  const heldTotal = budget.data?.monthlyTotal;
  useEffect(() => {
    if (seededSplit || heldSplit === undefined) return;
    setSplitDraft(heldSplit);
    setTotalText(minorToDraft(heldTotal ?? null));
    setSeededSplit(true);
  }, [seededSplit, heldSplit, heldTotal]);
  const savedSplit = completeSplit(splitDraft);
  const savedTotal = parseMinorDraft(totalText);
  const currency = budget.data?.homeCurrency ?? null;

  const saveSplit = useCallback(async (): Promise<void> => {
    if (savedSplit === null || savedTotal.state === "refused" || writer === null) return;
    // An empty field is "no total", which is a plan a user can hold and the way
    // a total is REMOVED — `budget_split_set` carries the whole plan, so an op
    // with no total states that there is none.
    const totalMinor = savedTotal.state === "amount" ? savedTotal.minor : null;
    setSplitSaving(true);
    try {
      // `budgetSplitOps` refuses anything that does not sum to 100, so the
      // disabled button and the op author agree — and the fold refuses it a
      // third time. There is no path by which a plan that does not add up
      // reaches the log.
      writer.enqueueMany(budgetSplitOps(savedSplit, totalMinor));
      setSplitNote(
        `Saved. Needs ${savedSplit.need}%, wants ${savedSplit.want}%, savings ${savedSplit.saving}%` +
          (totalMinor === null ? ", and no monthly budget." : `, on ${formatMoney(totalMinor, currency ?? "")} a month.`),
      );
      await invalidateAfterSync(qc);
      // Not awaited: the op is durable the moment it is queued, and a screen
      // that stalled on the network would be unusable offline.
      writer.flush().catch(() => {
        setSplitNote("Saved on this device — it will sync when you're back online.");
      });
    } finally {
      setSplitSaving(false);
    }
  }, [savedSplit, savedTotal, currency, writer, qc]);

  /**
   * The banks, in two halves that must not be confused: what ledger can READ
   * (`GET /api/v1/templates`, server truth) and what the user DECLARED (the op
   * log, through the projection). `BankPicker` draws the union, so a bank on the
   * waitlist — declared and unsupported — is still visible and still removable.
   */
  const supported = useQuery({
    queryKey: v2Keys.templates(),
    queryFn: () => templates(handle),
    staleTime: 5 * 60_000,
  });
  const declared = useDeclaredBanks(useBanksSource());
  const declaredActive = useMemo(() => activeBanks(declared.data ?? []), [declared.data]);
  /**
   * A template's `bank` is a free JSON string, so an id that `bank_declared`'s
   * grammar refuses would throw inside the toggle below — and with no error
   * boundary in this app that is a blank Settings screen. Such an id is not
   * offered; see `v2/bank.ts`'s `isDeclarableBankID` for the quieter second
   * failure it also catches.
   */
  const supportedIDs = useMemo(
    () => (supported.data ?? []).map((b) => b.id).filter(isDeclarableBankID),
    [supported.data],
  );

  const toggleBank = useCallback(
    (bank: string, next: boolean): void => {
      if (writer === null) return;
      // Belt as well as braces: the list above is filtered, and this is the
      // author. A row that could not be declared must be a no-op, never a throw.
      if (!isDeclarableBankID(bank)) return;
      // One op per bank, and a removal is a declaration (`active: false`) rather
      // than a delete — so a bank taken off and put back is one keyed record.
      writer.enqueueMany(bankDeclaredOps(bank, next));
      void invalidateAfterSync(qc);
      // Not awaited, for the reason the split's save is not: the op is durable
      // the moment it is queued.
      writer.flush().catch(() => {});
    },
    [writer, qc],
  );

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (sync.lastCompletedAt === null) return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [sync.lastCompletedAt]);
  const lastSynced = useMemo(
    () => (sync.lastCompletedAt === null ? null : sinceLabel(sync.lastCompletedAt, now())),
    // `tick` is the whole point of the memo: it is what makes the label re-read
    // the clock. `now` is a prop with a stable default.
    [sync.lastCompletedAt, now, tick],
  );

  return (
    <div className="space-y-6">
      {/* ---- Sync ---- */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">Your ledger</SectionLabel>
        <Card className="!p-0 divide-y divide-border overflow-hidden">
          <div data-testid="settings-sync" className="px-4 py-3.5 space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Sync</span>
              {busy ? (
                <span className="flex items-center gap-2 text-xs text-muted" role="status">
                  <PixelSpinner size={12} />
                  {PHASE_LABEL[phase] ?? "Working…"}
                </span>
              ) : halted !== null ? (
                <span className="text-xs font-medium text-bad">Stopped</span>
              ) : stopped ? (
                <span className="text-xs font-medium text-warn">Didn&rsquo;t finish</span>
              ) : (
                <span className="text-xs text-muted">{PHASE_LABEL.idle}</span>
              )}
            </div>
            {halted !== null ? (
              /*
                The reason verbatim, and no "sync now" beside it. `SyncEngine`
                refuses every later sync once it is halted, so a button here
                would be a control that cannot work offered at the exact moment
                trust matters most. `BootGate`'s wall is what explains a halt;
                this row's job is only to say it is in force.
              */
              <p className="text-xs text-bad font-mono break-words">{halted}</p>
            ) : stopped ? (
              /*
                No reason, so no claim about anybody's records — which is the
                honest thing to say and also the likeliest truth: the common
                cause is the connection. It says what is still true (nothing was
                lost) rather than what it cannot know.
              */
              <p className="text-xs text-warn">
                The last sync did not finish. Nothing was lost — this usually means ledger could not reach the
                server. {lastSynced === null ? "No sync has finished since you opened ledger." : `Last synced ${lastSynced}.`}
              </p>
            ) : (
              <p className="text-xs text-muted">
                {lastSynced === null ? "No sync has finished since you opened ledger." : `Last synced ${lastSynced}.`}
              </p>
            )}
            {halted === null && (
              <div className="pt-1">
                <Button variant="ghost" disabled={busy} onClick={() => void syncNow()}>
                  Sync now
                </Button>
              </div>
            )}
          </div>

          {onOpenQuarantine !== undefined && (
            <HubRow label="Held mail" value="Mail waiting on a decision" onClick={onOpenQuarantine} />
          )}
        </Card>
      </section>

      {/* ---- The banks ---- */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">Your banks</SectionLabel>
        <Card className="space-y-3">
          {supported.isPending ? (
            <div className="flex items-center gap-3 text-muted" role="status">
              <PixelSpinner size={12} />
              <span className="text-sm">Checking which banks ledger can read…</span>
            </div>
          ) : (
            <>
              {supported.isError && (
                <p className="text-xs text-warn">
                  ledger could not fetch the list of banks it can read. The banks you have already added are below
                  and can still be changed.
                </p>
              )}
              <BankPicker
                idPrefix="settings-bank"
                supported={supportedIDs}
                selected={declaredActive}
                onToggle={toggleBank}
              />
            </>
          )}
          {/*
            Every clause here is one the code honours. Removing a bank writes
            `bank_declared {active:false}` and NOTHING else: mail keeps arriving
            at the inbound address, the sender allowlist — a separate, server-side
            table written by the held-mail decision — is untouched, and no
            transaction is removed. Saying anything stronger would be describing
            a feature this product does not have.
          */}
          {/*
            The cut clause said this list "is what it counts when choosing which
            parser to write next". Nothing counts it: demand is the server-side
            `waitlist` table, written only by the explicit request button on the
            setup step. In a note whose whole purpose is to claim only what the
            code honours, that was the one sentence that did not.
          */}
          <p data-testid="settings-banks-note" className="text-xs leading-relaxed text-muted">
            This is the list ledger asked you for during setup, kept here so you can change it. Taking a bank off
            it leaves everything else as it is: mail sent to your address is still filed, senders you have already
            trusted are still trusted, and transactions already recorded are still there.
          </p>
        </Card>
      </section>

      {/* ---- The address ---- */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">Your inbound address</SectionLabel>
        <Card className="space-y-3">
          <p className="text-sm leading-relaxed text-muted">
            Bank mail forwarded here becomes transactions in ledger. Nothing else about your mailbox is read.
          </p>
          {inbound.isPending && shownAddress === null && (
            <div className="flex items-center gap-3 text-muted" role="status">
              <PixelSpinner size={12} />
              <span className="text-sm">Getting your address…</span>
            </div>
          )}
          {shownAddress !== null && (
            <>
              {/* `select-all` + `break-all`: it is longer than a phone is wide
                  and it is the one string here somebody may move by hand. */}
              <p data-testid="settings-inbound-address" className="font-mono text-sm select-all break-all">
                {shownAddress}
              </p>
              <Button variant="secondary" onClick={() => void onCopy(shownAddress)}>
                {copied === true ? "Copied" : "Copy address"}
              </Button>
              {copied === false && (
                <p role="status" className="text-xs text-bad">
                  This browser would not let ledger use the clipboard. The address above can be selected by hand.
                </p>
              )}
            </>
          )}
          {inbound.isError && (
            <p role="alert" className="text-sm text-bad">
              ledger could not read your address just now. Nothing is wrong with the address itself — it is created
              on the server and it is still there.
            </p>
          )}
        </Card>
      </section>

      {/* ---- The plan ----
          The counterpart of the onboarding step: the same control, the same
          rule that the three percentages must add up to 100, and the same
          refusal to normalise them. Unlike the home currency below, this IS
          changeable — a plan is a label over money that has already been
          bucketed, so changing it re-labels and never re-values. */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">Your plan</SectionLabel>
        <Card className="space-y-3">
          <p className="text-sm leading-relaxed text-muted">
            How you mean to divide what you earn: needs, wants, and what is saved or paid down, and what you mean to
            spend in a month. ledger shows your spending against it — it never moves money or blocks a purchase.
          </p>
          <BudgetSplitPicker value={splitDraft} onChange={setSplitDraft} idPrefix="settings-split" />
          <MonthlyTotalField value={totalText} onChange={setTotalText} currency={currency} idPrefix="settings-total" />
          <Button
            variant="primary"
            disabled={savedSplit === null || savedTotal.state === "refused" || splitSaving}
            onClick={() => void saveSplit()}
          >
            {splitSaving ? "Saving…" : "Save plan"}
          </Button>
          {splitNote !== null && (
            <p data-testid="settings-split-note" role="status" className="text-sm text-muted">
              {splitNote}
            </p>
          )}
        </Card>
      </section>

      {/* ---- Categories ---- */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">Categories</SectionLabel>
        <Card className="!p-0 divide-y divide-border overflow-hidden">
          <HubRow
            label="Your categories"
            value={
              categoryDefs.length === 0
                ? "The built-in set"
                : `${categoryDefs.filter((c) => c.active).length} of your own`
            }
            onClick={() => setCategoriesOpen(true)}
          />
        </Card>
      </section>

      {/* ---- Home currency: stated, never offered ---- */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">Home currency</SectionLabel>
        <Card className="space-y-1">
          <p data-testid="settings-home-currency" className="font-mono text-2xl tnum">
            {homeCurrency ?? "—"}
          </p>
          <p data-testid="settings-home-currency-note" className="text-sm leading-relaxed text-muted">
            ledger converts each foreign purchase once, when it arrives, and keeps that figure — so the home
            currency cannot be changed. The only way to a different one is a new account.
          </p>
        </Card>
      </section>

      {/* ---- Passkeys: the only backup this product can offer ---- */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">Passkeys</SectionLabel>
        <Card className="space-y-3">
          <div data-testid="settings-recovery-warning" className="space-y-2">
            <h3 className="text-sm font-semibold text-bad">{RECOVERY_WARNING.title}</h3>
            <p className="text-sm leading-relaxed text-muted">{RECOVERY_WARNING.body}</p>
            <p className="text-sm leading-relaxed text-muted">{RECOVERY_WARNING.advice}</p>
          </div>
          <p className="text-sm leading-relaxed text-muted">{ADD_PASSKEY_COPY.body}</p>
          <Button variant="primary" disabled={adding} onClick={() => void addPasskeyNow()}>
            {adding ? "Waiting for your authenticator…" : ADD_PASSKEY_COPY.action}
          </Button>
          {passkeyNote !== null && (
            <p data-testid="settings-passkey-note" role="status" className="text-sm text-muted">
              {passkeyNote}
            </p>
          )}
        </Card>
      </section>

      {/* ---- Adding a second device ---- */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">Your devices</SectionLabel>
        <Card className="space-y-3">
          <p className="text-sm leading-relaxed text-muted">
            A device that signs in for the first time can read this account, but it cannot make changes until a
            device that is already signed in approves it. Approving is done here, with a code that device shows
            you.
          </p>
          <Button variant="secondary" onClick={() => setAddDeviceOpen(true)}>
            Add a device
          </Button>
        </Card>
      </section>

      {/* ---- Signing out ---- */}
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">This device</SectionLabel>
        <Card className="!p-0 divide-y divide-border overflow-hidden">
          <Pressable
            onClick={() => setSignOutOpen(true)}
            className="w-full min-h-11 px-4 py-3.5 text-left text-sm font-medium text-bad hover:bg-surface-2/50"
          >
            Sign out
          </Pressable>
        </Card>
      </section>

      <p className="text-center text-xs text-muted pb-4">Icons by pixelarticons (MIT)</p>

      {categoriesOpen && (
        <Dialog title="Your categories" onClose={() => setCategoriesOpen(false)}>
          <V2CategoriesPanel
            defs={categoryDefs}
            writer={writer}
            onAuthored={() => void invalidateAfterSync(qc)}
          />
        </Dialog>
      )}

      {addDeviceOpen && (
        <Dialog title="Add a device" onClose={() => setAddDeviceOpen(false)}>
          <ApproveDevicePanel loadKeyHistory={loadKeyHistory} approve={approveDevice} />
        </Dialog>
      )}

      {signOutOpen && (
        <Dialog title="Sign out of ledger?" onClose={() => setSignOutOpen(false)}>
          <p className="text-sm leading-relaxed mb-4">
            Your passkey is the only way back in — there is no password to reset and no recovery address. Sign out
            only if you can still use the passkey for this account.
          </p>
          <p className="text-sm leading-relaxed text-muted mb-4">
            Nothing recorded on this device is deleted. It is picked up again when you sign back in.
          </p>
          <DialogFooter>
            <Button variant="ghost" disabled={signingOut} onClick={() => setSignOutOpen(false)}>
              Stay signed in
            </Button>
            <Button variant="danger" disabled={signingOut} onClick={() => void doSignOut()}>
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

/** The hub-row shape v1's Settings established, kept so the two look alike. */
function HubRow({ label, value, onClick }: { label: string; value?: string; onClick: () => void }) {
  return (
    <Pressable
      onClick={onClick}
      className="w-full min-h-11 flex items-center justify-between gap-3 px-4 py-3.5 text-sm font-medium text-left hover:bg-surface-2/50"
    >
      <span>{label}</span>
      <span className="flex items-center gap-2 text-muted min-w-0">
        {value !== undefined && <span className="truncate text-xs">{value}</span>}
        <ChevronRight size={16} aria-hidden className="shrink-0" />
      </span>
    </Pressable>
  );
}

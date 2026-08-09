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
 * # Four groups, and sync is not one of them
 *
 * The screen is v1's information architecture: eyebrow-labelled groups —
 * **Plan**, **Automation**, **Device**, **Library** — over `Card`s, so a person
 * looking for one control scans four words rather than eleven headings. There
 * is no Danger zone: v2 has nothing destructive to put in one, and a group
 * invented to complete the shape would be a heading with nothing under it.
 *
 * Sync sits ABOVE the groups because it is not a setting — there is nothing to
 * choose. It is the state of the thing the whole screen is about. The projection
 * is the data, it only moves when a sync writes it, and every screen reads it
 * silently, so without this line there is no way to tell "nothing has happened"
 * from "nothing is working". It carries the halt reason for the same reason
 * `BootGate` gives a halt the whole screen: an engine that has stopped standing
 * behind its records must never render as idle.
 *
 * # Text size, haptics and sound are device-local, and stay out of the log
 *
 * They are `localStorage`, read by `main.tsx` before first paint. They are a
 * property of this browser on this handset — how big the type is on a small
 * screen, whether this device may buzz — not of the account, and an op log
 * carrying them would push one device's screen size onto every other one.
 *
 * # The home currency is shown and NOT offered
 *
 * Spec §3.7: log state, set once, no in-product way to change it. A row with a
 * chevron on it would be a lie, so this one has neither a chevron nor a tap
 * target — just the code and the sentence saying why that is all there is.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { SecretStore } from "@ledger/client/store/store";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { Pressable } from "../../components/ui/Pressable";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Switch } from "../../components/ui/Switch";
import { ChevronRight } from "../../components/ui/PixelIcon";
import { sinceLabel } from "../../lib/sinceLabel";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  applyFontScale,
  loadFontScale,
  saveFontScale,
  type FontScale,
} from "../../lib/fontScale";
import {
  fire,
  isHapticsEnabled,
  isSoundEnabled,
  setHapticsEnabled,
  setSoundEnabled,
} from "../../lib/feedback";
import { fontScaleLabel } from "../../lib/settingsSummary";
import { readAddress } from "../../v2/address";
import { useV2OrThrow } from "../../v2/BootGate";
import {
  ADD_PASSKEY_COPY,
  CONFIRMATION_TASK_COPY,
  firstMailAt,
  RECOVERY_WARNING,
  type OnboardingFacts,
} from "../../v2/onboarding";
import { webSecretStore } from "../../v2/session";
import { Address } from "../onboarding/Address";
import { HomeCurrency } from "../onboarding/HomeCurrency";
import { SetupStatus } from "../onboarding/SetupStatus";
import { Verification } from "../onboarding/Verification";
import { addPasskey } from "../../v2/passkeyAdd";
import { passkeyFailureCopy } from "../../v2/passkeyCopy";
import {
  listPasskeys as listPasskeysApi,
  removePasskey as removePasskeyApi,
  type PasskeySummary,
} from "../../v2/passkeys";
import { PasskeysPanel } from "./PasskeysPanel";
import { pendingBanks } from "../../v2/authored";
import { BankPicker } from "../../components/BankPicker";
import { BudgetSplitPicker, completeSplit, type BudgetSplitDraft } from "../../components/BudgetSplitPicker";
import { MonthlyTotalField } from "../../components/MonthlyTotalField";
import { formatMoney, minorToDraft, parseMinorDraft } from "../../lib/minorMoney";
import { activeBanks, bankDeclaredOps } from "../../v2/sources/banks";
import { isDeclarableBankID } from "../../v2/bank";
import { readSupportedBanks, type SupportedBank } from "../../v2/onboardingIO";
import { budgetSplitOps, DEFAULT_BUDGET_SPLIT, usablePlan } from "../../v2/sources/budget";
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
import { DeleteAccountPanel } from "./DeleteAccountPanel";
import { PushNotificationsPanel } from "./PushNotificationsPanel";
// The profile and the server address the rest of the app runs under. Passed
// rather than defaulted so this screen's subscription is written under the same
// writer id and against the same origin as everything else the tab does.
import { PROFILE, SERVER } from "../../v2/BootGate";

export interface V2SettingsProps {
  /** Opens the held-mail drill-in. Absent hides the row. */
  onOpenQuarantine?: () => void;
  /** Test seam. Defaults to the real add-passkey ceremony. */
  addAnotherPasskey?: (handle: V2Handle) => Promise<string>;
  /**
   * Test seam. Defaults to `GET /api/v1/auth/passkeys` — a route the Go side
   * has not built yet, so in production the list shows its error state until
   * it lands. See `v2/passkeys.ts`.
   */
  listPasskeys?: (handle: V2Handle) => Promise<PasskeySummary[]>;
  /** Test seam. Defaults to `DELETE /api/v1/auth/passkeys/{id}` — same caveat. */
  removePasskey?: (handle: V2Handle, credentialId: string) => Promise<void>;
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
  /** Test seam: where the setup list's dismissal is kept. */
  secrets?: Pick<SecretStore, "get" | "set">;
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
  listPasskeys = (h) => listPasskeysApi({ client: h.client }),
  removePasskey = (h, credentialId) => removePasskeyApi({ client: h.client }, credentialId),
  address = (h) => readAddress(h.client),
  templates = (h) => readSupportedBanks(h.client),
  signOut = signOutAndReload,
  copy = writeClipboard,
  keyHistory = (h) => h.keyHistory(),
  approve = (h, request) => h.approveDevice(request),
  writer: injectedWriter,
  now = Date.now,
  secrets = webSecretStore(PROFILE),
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
  /** Bumped after a successful add so the list below re-reads the server. */
  const [passkeysReload, setPasskeysReload] = useState(0);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  /**
   * The three drill-ins that finish a step somebody skipped during setup.
   *
   * Onboarding proposes and never blocks, so a user can reach the product with
   * any of these undone — which only works if every one of them is completable
   * here afterwards, in the same words. They open the ONBOARDING screens rather
   * than second copies of them: the home-currency ceremony in particular states
   * its permanence in three places before the tap, and a paraphrase of that in
   * Settings is a paraphrase that drifts.
   */
  const [mailCheckOpen, setMailCheckOpen] = useState(false);
  const [forwardingOpen, setForwardingOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  /**
   * The three device-local preferences, held in React only so the rows redraw.
   *
   * The truth is `localStorage` and the module-level flags `main.tsx` hydrates
   * before first paint; these are read once at mount and written through on
   * every change. Nothing here is authored — see the note at the top of the
   * file for why a screen size must never travel to another device.
   */
  const [textSizeOpen, setTextSizeOpen] = useState(false);
  const [fontScale, setFontScale] = useState<FontScale>(loadFontScale);
  const [haptics, setHaptics] = useState(isHapticsEnabled);
  const [sound, setSound] = useState(isSoundEnabled);
  const setScale = useCallback((next: FontScale): void => {
    // Applied before it is saved: the scale a user picks has to land on the
    // glass under their finger, and a write that throws in private mode must
    // not be what decides whether they see it.
    applyFontScale(next);
    saveFontScale(next);
    setFontScale(next);
  }, []);
  // The definitions, not the categories the user has USED: this screen manages
  // the set on offer, and a retired one has to stay visible here so it can be
  // brought back.
  const categoryDefs = useCategoryChoices(useReviewSource()).data?.categoryDefs ?? [];

  // Bound here rather than inline in the JSX so the panel's fetch effect, which
  // depends on the identity of its loader, runs once per opening instead of on
  // every render of this screen.
  const loadKeyHistory = useCallback(() => keyHistory(handle), [keyHistory, handle]);
  // Same shape as `loadKeyHistory`: bound once so the panel's fetch effect runs
  // per reload, not per render of this screen.
  const loadPasskeys = useCallback(() => listPasskeys(handle), [listPasskeys, handle]);
  const removeOnePasskey = useCallback(
    (credentialId: string) => removePasskey(handle, credentialId),
    [removePasskey, handle],
  );
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
      // here the row can be used a third and fourth time, so the note must not
      // imply a count. The list below is the count — reloaded here so the new
      // credential appears the moment the ceremony lands.
      setPasskeyNote("A new passkey was added.");
      setPasskeysReload((n) => n + 1);
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
   * saved.
   *
   * # What `seededSplit` guards, stated exactly
   *
   * It fires ONCE, on the first usable snapshot. After it has fired, a sync
   * landing mid-edit cannot overwrite what the user is typing — that is the
   * guarantee, and it holds.
   *
   * Before it has fired the opposite is true: the seeding *will* replace what
   * is in these fields, because what is in them is a placeholder and not the
   * user's plan. Rather than leave that as a trap — a reviewer typed 70 and
   * 5000 into the pre-seed window and watched both vanish — the controls are
   * DISABLED until the seeding has happened, with a line saying why. Nothing
   * typed there could have reached the log (the save is gated on the same flag),
   * so the old behaviour was safe and merely disrespectful of the typing.
   *
   * # It seeds from a USABLE snapshot only, and that is a data-loss fix
   *
   * `sqlBudgetSource` answers an unusable projection with a PLACEHOLDER —
   * `{usable: false, split: DEFAULT_BUDGET_SPLIT, monthlyTotal: null}` — and a
   * placeholder is not `undefined`, so a presence check passed on it and the
   * latch closed over 50/30/20 and an empty total. The log's 60/20/20 and AED
   * 12,000 then never arrived, the fields sat on values nobody chose, and "Save
   * plan" authored them over the user's real plan.
   *
   * That is not a rare state. A projection is unusable for the whole of a
   * rebuild (`project` clears `complete` before the first row), and every
   * existing device rebuilds once on a `PROJECTION_VERSION` bump — of which the
   * monthly total's commit is one. Opening Settings during that window is the
   * ordinary case, not the unlucky one.
   *
   * The check is {@link usablePlan}, not `budget.data?.usable === true` written
   * here: an accessor cannot be forgotten the way a rule in a comment can, and
   * this exact shape reached review three times on this branch.
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
  const heldPlan = usablePlan(budget.data);
  useEffect(() => {
    if (seededSplit || heldPlan === undefined) return;
    setSplitDraft(heldPlan.split);
    setTotalText(minorToDraft(heldPlan.monthlyTotal));
    setSeededSplit(true);
  }, [seededSplit, heldPlan]);
  const savedSplit = completeSplit(splitDraft);
  const savedTotal = parseMinorDraft(totalText);
  const currency = budget.data?.homeCurrency ?? null;

  const saveSplit = useCallback(async (): Promise<void> => {
    // `seededSplit` is a GUARD here, not bookkeeping: until the projection has
    // been read, these fields hold defaults nobody chose, and writing them would
    // replace the plan in the log with them.
    if (!seededSplit || savedSplit === null || savedTotal.state === "refused" || writer === null) return;
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
  }, [seededSplit, savedSplit, savedTotal, currency, writer, qc]);

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
  /**
   * A render trigger with no other job.
   *
   * `declared` only reads `.data` below, and react-query's tracked-query
   * optimisation means a refetch that returns structurally-equal data (which
   * `invalidateAfterSync` always does here — no sync has run, so the
   * projection has not changed) never re-renders this component. Without this,
   * `declaredActive` is correct the NEXT time something else re-renders this
   * screen, but not the moment a bank is toggled — same problem `authoredTick`
   * solves in `Transactions.tsx`.
   */
  const [pendingTick, setPendingTick] = useState(0);
  /**
   * The projection plus what this device has queued but not yet synced.
   *
   * The projection alone does not move until a sync round-trips
   * (`writer.ts:28-30`), so without the overlay a second bank toggled in the
   * same sitting never appears: the refetch after the first toggle returns the
   * identical pre-toggle array. `pendingBanks` is last-wins per bank, laid over
   * the declared rows so a bank the projection already knows about can still be
   * flipped off before a sync. Memoised on `writer?.pending` and not `writer`
   * because `Client.emitMany` REPLACES that array rather than mutating it (see
   * `Transactions.tsx:169`) — a memo keyed on the writer object would never see
   * the new value.
   */
  const declaredActive = useMemo(() => {
    const merged = new Map((declared.data ?? []).map((d) => [d.bank, d.active]));
    for (const [bank, active] of pendingBanks(writer?.pending ?? [])) merged.set(bank, active);
    return activeBanks([...merged].map(([bank, active]) => ({ bank, active })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pendingTick is the change signal
  }, [declared.data, writer?.pending, pendingTick]);
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
      setPendingTick((n) => n + 1);
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
  /**
   * The setup facts as they are NOW, not as boot found them.
   *
   * `facts` is a snapshot taken before this screen existed, and everything on
   * this screen can change three of them. A list of what is still outstanding
   * that kept saying "add your banks" after a bank was added would be exactly
   * the nag the operator has already objected to, so it reads the same live
   * values the rows above it draw from.
   */
  const liveFacts: OnboardingFacts = {
    ...facts,
    banks: declaredActive,
    inboundAddress: shownAddress ?? facts.inboundAddress,
    homeCurrency: homeCurrency ?? null,
    // Mail that has arrived is proof a route exists, whatever this device
    // remembers about a button press.
    forwardingDeclared: facts.forwardingDeclared || facts.firstMailConfirmedAt !== null,
  };

  /**
   * The home-currency ops, authored the way every other op on this screen is.
   *
   * The ceremony that produces them is the onboarding screen, unchanged — this
   * is only the `commit` it was always given. Offered at all only while the log
   * carries no home currency; `HomeCurrency` refuses a second one on its own
   * (`existing`), because a second `home_currency_set` is a permanent anomaly no
   * later op can repair.
   */
  const commitCurrency = useCallback(
    (ops: readonly { type: string; payload: unknown }[]): void => {
      if (writer === null) return;
      writer.enqueueMany(ops);
      void invalidateAfterSync(qc);
      writer.flush().catch(() => {});
    },
    [writer, qc],
  );

  const lastSynced = useMemo(
    () => (sync.lastCompletedAt === null ? null : sinceLabel(sync.lastCompletedAt, now())),
    // `tick` is the whole point of the memo: it is what makes the label re-read
    // the clock. `now` is a prop with a stable default.
    [sync.lastCompletedAt, now, tick],
  );

  return (
    <div className="space-y-6">
      {/* ---- Sync: the state of the ledger, above the settings, not among them ---- */}
      <div data-testid="settings-sync" className="px-1 space-y-1">
        <div className="flex items-center justify-between gap-3">
          {busy ? (
            <span className="flex items-center gap-2 text-sm text-muted" role="status">
              <PixelSpinner size={12} />
              {PHASE_LABEL[phase] ?? "Working…"}
            </span>
          ) : halted !== null ? (
            <span className="text-sm font-medium text-bad">Sync stopped</span>
          ) : stopped ? (
            <span className="text-sm font-medium text-warn">Sync didn&rsquo;t finish</span>
          ) : (
            <span className="text-sm font-medium">{PHASE_LABEL.idle}</span>
          )}
          {halted === null && (
            /*
              No "Sync now" beside a halt. `SyncEngine` refuses every later sync
              once it is halted, so a button here would be a control that cannot
              work offered at the exact moment trust matters most. `BootGate`'s
              wall is what explains a halt; this line's job is only to say it is
              in force.
            */
            <Button variant="ghost" disabled={busy} onClick={() => void syncNow()}>
              Sync now
            </Button>
          )}
        </div>
        {halted !== null ? (
          <p className="text-xs text-bad font-mono break-words">{halted}</p>
        ) : stopped ? (
          /*
            No reason, so no claim about anybody's records — which is the honest
            thing to say and also the likeliest truth: the common cause is the
            connection. It says what is still true (nothing was lost) rather
            than what it cannot know.
          */
          <p className="text-xs text-warn">
            The last sync did not finish. Nothing was lost — ledger usually just could not reach the server.{" "}
            {lastSynced === null ? "No sync has finished since you opened ledger." : `Last synced ${lastSynced}.`}
          </p>
        ) : (
          <p className="text-xs text-muted">
            {lastSynced === null ? "No sync has finished since you opened ledger." : `Last synced ${lastSynced}.`}
          </p>
        )}
      </div>

      {/* What setup asked for and did not get, and whether mail is arriving.
          Above the groups because it is not a setting — it is the state of a
          setup that is allowed to be unfinished. It disappears for good when
          dismissed, and when there is nothing left to say. */}
      <SetupStatus facts={liveFacts} secrets={secrets} {...(onOpenQuarantine === undefined ? {} : { onOpenHeldMail: onOpenQuarantine })} />

      <Group label="Plan">
        {/* The counterpart of the onboarding step: the same control, the same
            rule that the three percentages must add up to 100, and the same
            refusal to normalise them. Unlike the home currency, this IS
            changeable — a plan is a label over money that has already been
            bucketed, so changing it re-labels and never re-values. */}
        <Panel title="Your plan">
          <p className="text-sm leading-relaxed text-muted">
            How you mean to divide what you earn: needs, wants, and what is saved or paid down, and what you mean to
            spend in a month. ledger shows your spending against it — it never moves money or blocks a purchase.
          </p>
          {/* Locked until the stored plan has been read, because until then
              these fields hold a placeholder the seeding is about to replace —
              and a control that discards what you typed is worse than one that
              would not let you type. The line says which of the two it is. */}
          <BudgetSplitPicker
            value={splitDraft}
            onChange={setSplitDraft}
            idPrefix="settings-split"
            disabled={!seededSplit}
          />
          <MonthlyTotalField
            value={totalText}
            onChange={setTotalText}
            currency={currency}
            idPrefix="settings-total"
            disabled={!seededSplit}
          />
          {!seededSplit && (
            <p data-testid="settings-plan-warming" role="status" className="text-sm text-muted">
              Reading your plan from this device. It will be ready in a moment — nothing is wrong.
            </p>
          )}
          <Button
            variant="primary"
            disabled={!seededSplit || savedSplit === null || savedTotal.state === "refused" || splitSaving}
            onClick={() => void saveSplit()}
          >
            {splitSaving ? "Saving…" : "Save plan"}
          </Button>
          {splitNote !== null && (
            <p data-testid="settings-split-note" role="status" className="text-sm text-muted">
              {splitNote}
            </p>
          )}
        </Panel>

        <Panel title="Your banks">
          {supported.isPending ? (
            <div className="flex items-center gap-3 text-muted" role="status">
              <PixelSpinner size={12} />
              <span className="text-sm">Checking which banks ledger can read…</span>
            </div>
          ) : (
            <>
              {supported.isError && (
                <p className="text-xs text-warn">
                  ledger could not fetch the list of banks it can read. The banks you added are below and can
                  still be changed.
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
        </Panel>
      </Group>

      <Group label="Automation">
        <Panel title="Your inbound address">
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
        </Panel>

        {/*
          The check that used to be a step, and the reason it is here instead.
          It waited for a real bank alert — an event the user cannot cause
          without spending money — so it sat between them and the product for as
          long as their bank felt like it. It is a status now, and it has to be
          re-runnable at ANY time: a forwarding rule can break, or be re-made,
          months after setup, and a check that only existed during onboarding is
          a check nobody can run when that happens.
        */}
        <Panel title="Is your mail arriving?">
          <p className="text-sm leading-relaxed text-muted">
            ledger checks by looking for mail that actually became a transaction. Run it whenever you like — a
            forwarding rule can stop working long after you set it up.
          </p>
          <Button variant="secondary" onClick={() => setMailCheckOpen(true)}>
            Check my mail setup
          </Button>
          <p data-testid="settings-confirmation-task" className="text-xs leading-relaxed text-muted">
            {CONFIRMATION_TASK_COPY.body}
          </p>
        </Panel>

        <RowCard>
          {/* The forwarding step, whether it was skipped during setup or is
              being re-done. Same screen, same instructions. */}
          <HubRow
            label="Forwarding instructions"
            value="How to send bank mail here"
            onClick={() => setForwardingOpen(true)}
          />
          {onOpenQuarantine !== undefined && (
            <HubRow label="Held mail" value="Mail waiting on a decision" onClick={onOpenQuarantine} />
          )}
        </RowCard>
      </Group>

      <Group label="Device" testID="settings-group-device">
        <RowCard>
          {/* About THIS browser, not the account — which is why it sits with
              the text size and the haptics and not with the plan. */}
          <PushNotificationsPanel client={handle.client} profile={PROFILE} server={SERVER} />
          <HubRow label="Text size" value={fontScaleLabel(fontScale)} onClick={() => setTextSizeOpen(true)} />
          <ToggleRow
            label="Haptics"
            checked={haptics}
            onChange={(v) => {
              setHapticsEnabled(v);
              setHaptics(v);
              if (v) fire("selection"); // confirm with a tick when switching on
            }}
          />
          <ToggleRow
            label="Sound"
            checked={sound}
            onChange={(v) => {
              setSoundEnabled(v);
              setSound(v);
              if (v) fire("selection"); // let the user hear it immediately
            }}
          />
        </RowCard>

        {/* Passkeys: the only backup this product can offer. */}
        <Panel title="Passkeys">
          <div data-testid="settings-recovery-warning" className="space-y-2">
            <h4 className="text-sm font-semibold text-bad">{RECOVERY_WARNING.title}</h4>
            <p className="text-sm leading-relaxed text-muted">{RECOVERY_WARNING.body}</p>
            <p className="text-sm leading-relaxed text-muted">{RECOVERY_WARNING.advice}</p>
          </div>
          {/* What the account can sign in with, and the way to end one. The
              last-passkey guard is the SERVER's; the panel also disables the
              control, with the reason shown. */}
          <PasskeysPanel list={loadPasskeys} remove={removeOnePasskey} reloadKey={passkeysReload} />
          <p className="text-sm leading-relaxed text-muted">{ADD_PASSKEY_COPY.body}</p>
          <p className="text-sm leading-relaxed text-muted">
            A passkey you already have keeps its old name until you remove and re-add it. Passkeys cannot be
            renamed.
          </p>
          <Button variant="primary" disabled={adding} onClick={() => void addPasskeyNow()}>
            {adding ? "Waiting for your authenticator…" : ADD_PASSKEY_COPY.action}
          </Button>
          {passkeyNote !== null && (
            <p data-testid="settings-passkey-note" role="status" className="text-sm text-muted">
              {passkeyNote}
            </p>
          )}
        </Panel>

        <Panel title="Your devices">
          <p className="text-sm leading-relaxed text-muted">
            A device that signs in for the first time can read this account, but it cannot make changes until a
            device that is already signed in approves it. Approving is done here, with a code that device shows
            you.
          </p>
          <Button variant="secondary" onClick={() => setAddDeviceOpen(true)}>
            Add a device
          </Button>
        </Panel>

        {/* Last in the group, after everything a person came here to change:
            the one control on this screen they must not hit while reaching for
            another. Library follows it, because a category list is not
            something anybody scrolls past Sign out to reach by accident. */}
        <RowCard>
          <Pressable
            onClick={() => setSignOutOpen(true)}
            className="w-full min-h-11 px-4 py-3.5 text-left text-sm font-medium text-bad hover:bg-surface-2/50"
          >
            Sign out
          </Pressable>
        </RowCard>
      </Group>

      <Group label="Library">
        <RowCard>
          <HubRow
            label="Your categories"
            value={
              categoryDefs.length === 0
                ? "The built-in set"
                : `${categoryDefs.filter((c) => c.active).length} of your own`
            }
            onClick={() => setCategoriesOpen(true)}
          />
        </RowCard>

        {/* Home currency: stated, never CHANGED — and offered exactly once, to
            an account that skipped it during setup. Those are different things,
            and conflating them is what would make this row a lie. Setting a
            currency that has never been set is not a change; the ceremony is
            the onboarding one, with the same permanence warning in the same
            three places, and it is unreachable the moment one exists. */}
        <Panel title="Home currency">
          <p data-testid="settings-home-currency" className="font-mono text-2xl tnum">
            {homeCurrency ?? "—"}
          </p>
          {homeCurrency === null ? (
            <>
              <p data-testid="settings-home-currency-unset" className="text-sm leading-relaxed text-muted">
                You have not set one. Totals stay in the currency each purchase was made in until you do. It is set
                once and cannot be changed afterwards.
              </p>
              <Button variant="secondary" disabled={writer === null} onClick={() => setCurrencyOpen(true)}>
                Set my home currency
              </Button>
            </>
          ) : (
            <p data-testid="settings-home-currency-note" className="text-sm leading-relaxed text-muted">
              ledger converts each foreign purchase once, when it arrives, and keeps that figure — so the home
              currency cannot be changed. The only way to a different one is a new account.
            </p>
          )}
        </Panel>
      </Group>

      {/* The first destructive action v2 has. The settings design said not to
          invent a Danger zone "to fill the shape" — that instruction was written
          when there was nothing destructive; deletion is now real, so the group
          is now correct. Exactly one row, last, below everything reversible. */}
      <Group label="Danger zone" testID="settings-danger">
        <RowCard>
          <HubRow label="Delete account" onClick={() => setDeleteAccountOpen(true)} />
        </RowCard>
      </Group>

      <p className="text-center text-xs text-muted pb-4">Icons by pixelarticons (MIT)</p>

      {textSizeOpen && (
        <Dialog title="Text size" onClose={() => setTextSizeOpen(false)}>
          <p className="text-sm leading-relaxed text-muted mb-3">
            Scales all text in ledger on this device. It applies straight away.
          </p>
          {/* fullWidth, not a horizontal scroller: at 320px the scroller clipped
              the control at the viewport edge, and the clipped segment was the
              selected one. */}
          <SegmentedControl
            fullWidth
            value={String(fontScale)}
            onChange={(v) => setScale(Number(v) as FontScale)}
            options={FONT_SCALE_OPTIONS.map((n) => ({ value: String(n), label: `${n}%` }))}
          />
          {fontScale !== DEFAULT_FONT_SCALE && (
            <Button variant="ghost" className="mt-3 text-sm" onClick={() => setScale(DEFAULT_FONT_SCALE)}>
              Reset to default
            </Button>
          )}
        </Dialog>
      )}

      {categoriesOpen && (
        <Dialog title="Your categories" onClose={() => setCategoriesOpen(false)}>
          <V2CategoriesPanel
            defs={categoryDefs}
            writer={writer}
            onAuthored={() => void invalidateAfterSync(qc)}
          />
        </Dialog>
      )}

      {mailCheckOpen && (
        <Dialog title="Is your mail arriving?" onClose={() => setMailCheckOpen(false)}>
          {/*
            No `onConfirmed`: there is no walk to advance. The screen reports
            what it measured — a transaction in the log — which is the same
            measurement it made when it was a step.
          */}
          <Verification
            embedded
            client={handle.client}
            firstMailAt={() => firstMailAt(handle.client.state())}
            sync={syncNow}
            server={SERVER}
          />
        </Dialog>
      )}

      {forwardingOpen && (
        <Dialog title="Forwarding instructions" onClose={() => setForwardingOpen(false)}>
          <Address
            embedded
            client={handle.client}
            phase="forwarding"
            known={shownAddress}
            server={SERVER}
            onIssued={() => {}}
            // Nothing to declare to: the fact is the walk's, and the walk is
            // over. Saying "I have set this up" here simply closes the drawer.
            onForwardingDeclared={() => setForwardingOpen(false)}
          />
        </Dialog>
      )}

      {currencyOpen && (
        <Dialog title="Home currency" onClose={() => setCurrencyOpen(false)}>
          <HomeCurrency
            embedded
            commit={commitCurrency}
            existing={homeCurrency}
            onSet={() => setCurrencyOpen(false)}
          />
        </Dialog>
      )}

      {addDeviceOpen && (
        <Dialog title="Add a device" onClose={() => setAddDeviceOpen(false)}>
          <ApproveDevicePanel loadKeyHistory={loadKeyHistory} approve={approveDevice} />
        </Dialog>
      )}

      {deleteAccountOpen && (
        <Dialog title="Delete account" onClose={() => setDeleteAccountOpen(false)}>
          <DeleteAccountPanel handle={handle} />
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

/**
 * One eyebrow-labelled group of settings — v1's `SettingsHub` shape, kept so the
 * two apps read alike.
 *
 * The children are `Card`s rather than rows, because v2's settings are not all
 * rows: a bank picker and a budget split are panels with prose, and forcing
 * them into a list of chevrons would have meant four more drill-ins to build.
 * A group is therefore a heading over one or more cards, each named by
 * {@link Panel} unless it is a plain list of rows ({@link RowCard}).
 */
function Group({ label, testID, children }: { label: string; testID?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2" {...(testID === undefined ? {} : { "data-testid": testID })}>
      <SectionLabel as="h2" className="px-1">
        {label}
      </SectionLabel>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** A card of tappable rows: `!p-0` because each row carries its own padding. */
function RowCard({ children }: { children: React.ReactNode }) {
  return <Card className="!p-0 divide-y divide-border overflow-hidden">{children}</Card>;
}

/** A named card inside a {@link Group}, for the controls that are not one row. */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </Card>
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

/** An inline switch row, for a preference with nothing to drill into. */
function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="w-full min-h-11 flex items-center justify-between gap-3 px-4 py-3.5 text-sm font-medium cursor-pointer select-none">
      <span>{label}</span>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

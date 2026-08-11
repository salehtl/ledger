/**
 * Settings, in v2: the facts about this account, and the controls that are not
 * reachable anywhere else.
 *
 * # This screen replaced `screens/Settings.tsx` — it did not sit beside it
 *
 * v1's Settings hub read `/api/budget`, `/api/settings`, `/api/categories`,
 * `/api/rules`, `/api/rates`, `/api/health`, `/api/accounts`, `/api/projects`,
 * `/api/scheduled` and `/api/settings/notifications`. `ledgerd` serves none of
 * them, and every one of those queries would have sat `isPending` forever
 * behind a row that looked like it was loading. It was left unrouted while
 * this screen (and `V2CategoriesPanel` for categories) grew a projection to
 * read instead, then deleted on 2026-08-10 (cca2da8) once they covered the
 * same ground — git history has the original.
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
 * # A row is one line; anything that needs a paragraph is a screen
 *
 * That is the rule the 2026-08-10 restructure imposed, and the long comment
 * over the groups below records what it replaced. Five eyebrow-labelled groups
 * — **Your money**, **Bank mail**, **This device**, **Your data**, **Account**
 * — each a `Card` of one-line rows, named for what the user owns rather than
 * for the system that serves it. Seven subjects that needed a paragraph became
 * drill-ins ({@link Sub}); `SettingsPage` nests, so each renders as a second
 * panel over this one with the same back arrow and edge-swipe.
 *
 * **Account** is the last group and it does hold the destructive control:
 * sign out and delete account, which is why it carries `settings-danger`.
 * Deletion is the one irreversible thing v2 has, and it stays last.
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
 * # The home currency is stated, never CHANGED — and offered exactly once
 *
 * Spec §3.7: log state, set once, no in-product way to change it. The row is a
 * drill-in like any other, and what it opens says which of those two cases the
 * account is in. With a currency set it shows the code and the sentence saying
 * why that is all there is. With none set — an account that skipped the step
 * during setup — it offers the onboarding ceremony, with the same permanence
 * warning: setting a currency that has never been set is not a change, and the
 * offer is unreachable the moment one exists.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";


import { Button } from "../../components/ui/Button";
import { ExportData } from "../ExportData";
import { ImportFile } from "../ImportFile";
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
} from "../../v2/onboarding";
import { Address } from "../onboarding/Address";
import { HomeCurrency } from "../onboarding/HomeCurrency";
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
import { bankDisplayName, isDeclarableBankID } from "../../v2/bank";
import { SettingsPage } from "./SettingsPage";
import { readSupportedBanks, type SupportedBank } from "../../v2/onboardingIO";
import { budgetSplitOps, DEFAULT_BUDGET_SPLIT, usablePlan } from "../../v2/sources/budget";
import { useSettleAuthored } from "../../v2/settle";
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
  /**
   * Told when one of this screen's own drill-ins opens or closes.
   *
   * The panel that HOSTS Settings owns a back arrow this component cannot
   * reach, and that arrow stayed focusable behind every drill-in — press it
   * from a covered layer and you close the screen underneath the one you are
   * looking at. `SettingsPage` already takes `covered` for exactly this; this is
   * how the host learns to pass it.
   */
  onDrillChange?: (open: boolean) => void;
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
async function signOutAndReload(handle: V2Handle): Promise<void> {
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

/**
 * The subjects that are a screen rather than a row.
 *
 * Each one needs a paragraph, and a paragraph does not belong on a settings
 * row — see the rule at the top of this component's render.
 */
type Sub = "plan" | "banks" | "address" | "mail" | "passkeys" | "devices" | "currency" | null;

export function V2Settings({
  onOpenQuarantine,
  onDrillChange,
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
}: V2SettingsProps) {
  const { handle, sync, coordinator, facts } = useV2OrThrow();
  const qc = useQueryClient();
  const settle = useSettleAuthored();
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
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
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

  /**
   * Which drill-in is open over this screen, if any.
   *
   * Settings is a list of one-line rows; every subject that needs a paragraph
   * is one of these. `SettingsPage` nests, so a drill-in renders as a second
   * full-screen panel over this one with the same back arrow and edge-swipe —
   * the same stacking AppShell already does for Settings over the tabs.
   */
  const [sub, setSub] = useState<Sub>(null);
  useEffect(() => {
    onDrillChange?.(sub !== null);
  }, [sub, onDrillChange]);

  /**
   * The plan has unsaved edits.
   *
   * Compared against what the projection actually holds, not against a snapshot
   * taken when the screen opened: seeding lands asynchronously, so a snapshot
   * would read "dirty" for every plan on every open. Before the seeding
   * finishes there is nothing to lose, hence the `seededSplit` guard.
   */
  const planDirty =
    seededSplit &&
    heldPlan !== undefined &&
    (splitDraft.need !== heldPlan.split.need ||
      splitDraft.want !== heldPlan.split.want ||
      splitDraft.saving !== heldPlan.split.saving ||
      totalText !== minorToDraft(heldPlan.monthlyTotal));

  /**
   * Leaving the plan, with a word first if there is work to lose.
   *
   * The plan is the one control on Settings with a Save button, so backing out
   * of it used to discard silently. `confirm` rather than a second sheet: this
   * is a rare, recoverable slip on the way out of a screen, and a purpose-built
   * dialog for it would be more chrome than the case deserves.
   */
  const closePlan = useCallback(() => {
    if (planDirty && !window.confirm("Leave without saving your plan? The changes you made here will be lost.")) {
      return;
    }
    setSub(null);
  }, [planDirty]);

  /** What the Plan row says without opening it. */
  const planSummary =
    savedSplit === null ? "Not set" : `${savedSplit.need} / ${savedSplit.want} / ${savedSplit.saving}`;

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

  /**
   * What the Banks row says without opening it.
   *
   * Naming the banks beats counting them — you recognise your own bank at a
   * glance, where "2 banks" tells you only that you once answered the question.
   * So it degrades by how much room a row has: one bank gets its real name, two
   * get their short ids, and past that only a count fits.
   */
  const banksSummary = useMemo(() => {
    if (declaredActive.length === 0) return "None yet";
    if (declaredActive.length === 1) return bankDisplayName(declaredActive[0]!);
    if (declaredActive.length === 2) return declaredActive.map((id) => id.toUpperCase()).join(", ");
    return `${String(declaredActive.length)} banks`;
  }, [declaredActive]);

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
      // the moment it is queued. Once the upload lands, settle (sync + re-read).
      writer.flush().then(
        () => void settle(),
        () => {},
      );
    },
    [writer, qc, settle],
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
      writer.flush().then(
        () => void settle(),
        () => {},
      );
    },
    [writer, qc, settle],
  );

  const lastSynced = useMemo(
    () => (sync.lastCompletedAt === null ? null : sinceLabel(sync.lastCompletedAt, now())),
    // `tick` is the whole point of the memo: it is what makes the label re-read
    // the clock. `now` is a prop with a stable default.
    [sync.lastCompletedAt, now, tick],
  );

  return (
    <div className="space-y-6">
      {/*
        Everything on Settings itself goes inert while a drill-in is over it.

        `AppShell` does this for the layers it owns — Settings over the tabs,
        held mail over Settings — but a drill-in opened from HERE is a sibling it
        does not know about, so without this each of the seven left nineteen
        controls behind the panel still focusable, reachable by Tab and by a
        screen-reader swipe. `audit.mjs` reported it on all seven the first time
        this restructure was measured.

        `display: contents`, so the wrapper adds no box and the `space-y-6`
        rhythm above is unchanged.
      */}
      <div className="contents" inert={sub !== null}>
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

      {/*
        THE RULE THIS SCREEN IS BUILT ON: a settings row is one line, and
        anything that needs a paragraph is a screen rather than a row.

        Before this pass Settings was six full viewport-heights (~4,900px at
        390px) of expanded panels, each arguing its case before you could act:
        the Passkeys panel alone ran a screen and a half of prose before its
        button, the plan editor sat inline with the only Save on the screen, and
        row labels wrapped to two lines ("Import a / statement") while their
        values truncated. A settings screen's job is to get you to a decision,
        not to make the case for it first.

        So every paragraph moved to the drill-in it belongs to, where the reader
        has already chosen to care. **Nothing was deleted** — several of these
        sentences are load-bearing (the recovery warning, what removing a bank
        does not do, the home currency's permanence) and they are asserted by
        `V2Settings.test.tsx` on the screens they now live on.

        The groups are named for what the user owns rather than for the system
        that serves it: "Automation" and "Library" were our words, not theirs.
      */}

      <Group label="Your money">
        <RowCard>
          <HubRow label="Plan" value={planSummary} onClick={() => setSub("plan")} />
          <HubRow
            label="Home currency"
            value={homeCurrency ?? "Not set"}
            onClick={() => setSub("currency")}
          />
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
      </Group>

      <Group label="Bank mail" testID="settings-group-mail">
        <RowCard>
          {/* The address is the one value here worth showing on the row: it is
              read far more often than it is changed, and a truncated copy of it
              is enough to recognise. The full string, and the one control that
              matters, are a tap away. */}
          <HubRow label="Your address" value={shownAddress ?? "Getting it…"} onClick={() => setSub("address")} />
          <HubRow label="Is mail arriving?" value="Check it now" onClick={() => setSub("mail")} />
          <HubRow
            label="Forwarding instructions"
            value="How to send mail here"
            onClick={() => setForwardingOpen(true)}
          />
          {onOpenQuarantine !== undefined && (
            <HubRow label="Held mail" value="Waiting on a decision" onClick={onOpenQuarantine} />
          )}
          <HubRow label="Your banks" value={banksSummary} onClick={() => setSub("banks")} />
        </RowCard>
      </Group>

      <Group label="This device" testID="settings-group-device">
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
          <HubRow label="Passkeys" value="How you sign in" onClick={() => setSub("passkeys")} />
          <HubRow label="Other devices" value="Approve a new one" onClick={() => setSub("devices")} />
        </RowCard>
      </Group>

      {/*
        Your data: the directions it can move under the user's own hand. Import
        is here as well as in setup because a statement is exported once a
        month, not once in a lifetime, and a control reachable only during
        onboarding is a control nobody uses twice.
      */}
      <Group label="Your data" testID="settings-group-data">
        <RowCard>
          <HubRow label="Import a statement" value="From a CSV file" onClick={() => setImportOpen(true)} />
          {/* The export half of the alpha consent promise — "access, export and
              delete… all of which are available in the app". It is a row and not
              a buried link because the sentence it satisfies is countersigned. */}
          <HubRow label="Download my data" value="As a CSV file" onClick={() => setExportOpen(true)} />
        </RowCard>
      </Group>

      {/*
        Account: leaving, and the one destructive action v2 has. Both are here
        rather than scattered — sign out used to sit at the bottom of the device
        group, above a category list, where it was the control you passed while
        reaching for something else. Deletion stays last.
      */}
      <Group label="Account" testID="settings-danger">
        <RowCard>
          <Pressable
            onClick={() => setSignOutOpen(true)}
            className="w-full min-h-11 px-4 py-3.5 text-left text-sm font-medium text-bad hover:bg-surface-2/50"
          >
            Sign out
          </Pressable>
          <HubRow label="Delete account" onClick={() => setDeleteAccountOpen(true)} />
        </RowCard>
      </Group>

      <p className="text-center text-xs text-muted pb-4">Icons by pixelarticons (MIT)</p>
      </div>

      {/*
        The drill-ins. Every one of these was an expanded panel on the screen
        above until this pass, and each is here for the same reason: it needs a
        paragraph, and a paragraph does not belong on a row.

        `SettingsPage` nests — AppShell already stacks Settings over the tabs and
        held mail over Settings — so these render as a second panel over this
        one, with the same back arrow and the same edge-swipe. The state stays
        in this component rather than moving with the JSX: these subjects share
        the plan draft, the address read and the passkey list with the rows that
        summarise them, and prop-drilling that into five files would trade one
        kind of clutter for another.
      */}
      {sub === "plan" && (
        <SettingsPage title="Your plan" onClose={closePlan}>
          <div className="space-y-4">
            {/* The counterpart of the onboarding step: the same control, the same
                rule that the three percentages must add up to 100, and the same
                refusal to normalise them. Unlike the home currency, this IS
                changeable — a plan is a label over money that has already been
                bucketed, so changing it re-labels and never re-values. */}
            <p className="text-sm leading-relaxed text-muted">
              How you mean to divide what you earn: needs, wants, and what is saved or paid down, and what you mean
              to spend in a month. ledger shows your spending against it — it never moves money or blocks a purchase.
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
            {/*
              The plan is the only thing on Settings with a Save button, which
              made backing out of it a silent discard — you typed a split, went
              back, and nothing said the edit had gone. Now leaving with unsaved
              changes asks first. It is a confirmation on a REVERSIBLE action,
              which the principles normally forbid; it earns its place because
              the alternative is losing work with no notice, and it only appears
              when there is work to lose.
            */}
            {planDirty && (
              <p role="status" className="text-xs text-warn">
                Not saved yet. Going back will discard this.
              </p>
            )}
          </div>
        </SettingsPage>
      )}

      {sub === "banks" && (
        <SettingsPage title="Your banks" onClose={() => setSub(null)}>
          <div className="space-y-4">
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
            <p data-testid="settings-banks-note" className="text-xs leading-relaxed text-muted">
              This is the list ledger asked you for during setup, kept here so you can change it. Taking a bank off
              it leaves everything else as it is: mail sent to your address is still filed, senders you have already
              trusted are still trusted, and transactions already recorded are still there.
            </p>
          </div>
        </SettingsPage>
      )}

      {sub === "address" && (
        <SettingsPage title="Your address" onClose={() => setSub(null)}>
          <div className="space-y-4">
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
                ledger could not read your address just now. Nothing is wrong with the address itself — it is
                created on the server and it is still there.
              </p>
            )}
          </div>
        </SettingsPage>
      )}

      {/*
        The check that used to be a step, and the reason it is here instead. It
        waited for a real bank alert — an event the user cannot cause without
        spending money — so it sat between them and the product for as long as
        their bank felt like it. It is a status now, and it has to be re-runnable
        at ANY time: a forwarding rule can break, or be re-made, months after
        setup, and a check that only existed during onboarding is a check nobody
        can run when that happens.
      */}
      {sub === "mail" && (
        <SettingsPage title="Is mail arriving?" onClose={() => setSub(null)}>
          <div className="space-y-4">
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
          </div>
        </SettingsPage>
      )}

      {/* Passkeys: the only backup this product can offer. */}
      {sub === "passkeys" && (
        <SettingsPage title="Passkeys" onClose={() => setSub(null)}>
          <div className="space-y-4">
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
          </div>
        </SettingsPage>
      )}

      {sub === "devices" && (
        <SettingsPage title="Other devices" onClose={() => setSub(null)}>
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted">
              A device that signs in for the first time can read this account, but it cannot make changes until a
              device that is already signed in approves it. Approving is done here, with a code that device shows
              you.
            </p>
            <Button variant="secondary" onClick={() => setAddDeviceOpen(true)}>
              Add a device
            </Button>
          </div>
        </SettingsPage>
      )}

      {/* Home currency: stated, never CHANGED — and offered exactly once, to an
          account that skipped it during setup. Those are different things, and
          conflating them is what would make this row a lie. Setting a currency
          that has never been set is not a change; the ceremony is the onboarding
          one, with the same permanence warning in the same three places, and it
          is unreachable the moment one exists. */}
      {sub === "currency" && (
        <SettingsPage title="Home currency" onClose={() => setSub(null)}>
          <div className="space-y-4">
            <p data-testid="settings-home-currency" className="font-mono text-2xl tnum">
              {homeCurrency ?? "—"}
            </p>
            {homeCurrency === null ? (
              <>
                <p data-testid="settings-home-currency-unset" className="text-sm leading-relaxed text-muted">
                  You have not set one. Totals stay in the currency each purchase was made in until you do. It is
                  set once and cannot be changed afterwards.
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
          </div>
        </SettingsPage>
      )}

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

      {exportOpen && (
        <Dialog title="Download my data" onClose={() => setExportOpen(false)}>
          <ExportData />
        </Dialog>
      )}

      {importOpen && (
        <Dialog title="Import a statement" onClose={() => setImportOpen(false)}>
          <ImportFile />
        </Dialog>
      )}

      {categoriesOpen && (
        <Dialog title="Your categories" onClose={() => setCategoriesOpen(false)}>
          <V2CategoriesPanel
            defs={categoryDefs}
            writer={writer}
            onAuthored={() => void invalidateAfterSync(qc)}
            onFlushed={() => void settle()}
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
            // The held-confirmation notice's fallback, when its message has no
            // link ledger could pin: the tap opens held mail — the same seam
            // the Held mail row uses — rather than commanding an action the
            // dialog cannot perform.
            {...(onOpenQuarantine === undefined ? {} : { onOpenHeldMail: onOpenQuarantine })}
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

/**
 * A named card inside a {@link Group}, for the controls that are not one row.
 *
 * `info` is an `InfoTip` beside the title — for the "why" behind a group, which
 * is what Settings has most of and what makes these screens read as walls. It is
 * never where a consequence goes; see `InfoTip`'s header.
 */
function Panel({ title, info, children }: { title: string; info?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {info}
      </div>
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
      {/* The LABEL does not shrink; the value does.
          Both sides were shrinkable, so a row with a long value wrapped its
          label instead of truncating the value — "Import a / statement" and
          "Forwarding / instructions" on two lines each, beside a value that had
          room to spare. The label is the row's identity and the only part you
          scan for; the value is a summary, and a summary is allowed to end in
          an ellipsis. */}
      <span className="shrink-0">{label}</span>
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

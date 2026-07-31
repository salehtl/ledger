import { Money } from "../../components/Money";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { Pressable } from "../../components/ui/Pressable";
import { categoryColor } from "../../lib/categoryColor";
import { paceTone } from "../../lib/insights";
import {
  claimShort,
  claimText,
  envelopeBar,
  filsLabel,
  isOverspent,
  neededLabel,
  targetLabel,
  type CategoryClaim,
  type Envelope,
} from "../../lib/envelope";
import { formatFils } from "../../lib/money";

const TONE_TEXT = { good: "text-good", warn: "text-warn", bad: "text-bad" } as const;
const VERDICT = { over: "Over pace", overbudget: "Overspent" } as const;

/**
 * One envelope line: name + available on top, the jar-style pace bar beneath,
 * then a mono meta line (target progress / assigned math) with a quiet verdict
 * on the right. A category that was never funded and has no target is a "jar
 * row": plain spend, no bar, no overspend shouting — envelope depth is opt-in.
 * The whole row is the tap target (opens the assign sheet).
 */
export function EnvelopeRow({ envelope, claim, pace, color, onOpen }: {
  envelope: Envelope;
  /** Upcoming-bill claim on this category, if any (from /api/upcoming). */
  claim?: CategoryClaim;
  /** Fraction of the month elapsed — the bar's pace marker. */
  pace?: number;
  /** The category's own stored colour (palette name, may be unset) — the
   *  envelope wire shape carries no colour of its own, so the caller looks
   *  it up against the category inventory and passes it down. */
  color?: string | null;
  onOpen: (e: Envelope) => void;
}) {
  const e = envelope;
  const bar = envelopeBar(e, pace);
  const enveloped = bar !== null;
  const overspent = isOverspent(e);
  const short = claim && enveloped ? claimShort(claim, e.available_fils) : 0;

  const metaLeft = e.target
    ? targetLabel(e.target)
    : enveloped
      ? `spent ${filsLabel(e.activity_fils)} of ${filsLabel(e.carryover_fils + e.assigned_fils)}`
      : "no envelope yet — tap to assign";

  // Right meta slot, by urgency: trouble verdicts, then the target's ask, then
  // the quiet column label. Under-pace rows stay quiet.
  const alarm = bar && bar.status !== "under" ? bar.status : null;
  const verdict = alarm
    ? VERDICT[alarm]
    : e.target
      ? neededLabel(e.target)
      : enveloped
        ? "available"
        : e.activity_fils !== 0
          ? "spent"
          : "no spend";
  const verdictClass = alarm ? `font-medium ${TONE_TEXT[paceTone(alarm)]}` : "text-muted";

  return (
    <Pressable
      onClick={() => onOpen(e)}
      aria-label={`Open ${e.category_name}`}
      data-envelope={enveloped ? (overspent ? "overspent" : "funded") : "jar"}
      className="w-full text-left px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 flex items-center gap-2 text-sm font-medium leading-5 tracking-[-0.01em]">
          {/* The category's own colour, leading the name. Solid, not
              ColorSwatch — form keeps it distinct from a project's hatched
              mark at the same hue. aria-hidden: the name carries identity. */}
          <span aria-hidden className="w-2.5 h-2.5 rounded-[var(--radius)] shrink-0" style={{ backgroundColor: categoryColor(color) }} />
          <span className="truncate">{e.category_name}</span>
        </p>
        {/* An envelope spent to exactly its balance has 0.00 available — a
            real, and rather important, figure. Money renders 0 as "—", which
            read as "no data" on precisely the rows that most need a number. */}
        <span className="tnum font-medium leading-5 shrink-0">
          {enveloped && e.available_fils === 0 ? "0.00" : <Money fils={enveloped ? e.available_fils : e.activity_fils} />}
        </span>
      </div>
      {enveloped && (
        <div className="mt-2">
          <ProgressBar pct={bar.pct} pace={pace} status={bar.status} label={`${e.category_name} envelope used`} />
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[10px] tracking-[0.04em]">
        <span className="min-w-0 truncate text-muted tnum">{metaLeft}</span>
        <span className={`shrink-0 ${verdictClass}`}>{verdict}</span>
      </div>
      {claim && (
        <p
          data-claim={short > 0 ? "short" : "covered"}
          className={`mt-1 font-mono text-[10px] tracking-[0.04em] tnum ${short > 0 ? "text-fg" : "text-muted"}`}
        >
          {claimText(claim)}
          {short > 0 && ` — short ${formatFils(short)}`}
        </p>
      )}
    </Pressable>
  );
}

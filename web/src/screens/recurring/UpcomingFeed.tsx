import { Card } from "../../components/ui/Card";
import { Pressable } from "../../components/ui/Pressable";
import { Pill } from "../../components/ui/Pill";
import { Money } from "../../components/Money";
import { flowAmount } from "../../lib/money";
import { EmptyState } from "../../components/EmptyState";
import { Inbox } from "../../components/ui/PixelIcon";
import { cadenceLabel, dueLabel, priceChangeLine, scheduleName } from "../../lib/recurring";
import { shortDate } from "../../lib/format";
import type { Schedule, UpcomingItem } from "../../api/types";

/**
 * The next-N-days bill feed. Overdue bills lead (they are money already owed),
 * then bills soonest-first as the API orders them. Meaning rides on labels —
 * "Missed" / "Price change" pills print in ink, never a second red — and a
 * price change explains itself on a second meta line instead of making the
 * user diff two numbers.
 */
export function UpcomingFeed({ items, onOpen }: {
  items: UpcomingItem[];
  onOpen: (s: UpcomingItem) => void;
}) {
  if (items.length === 0) {
    return <EmptyState icon={Inbox} title="Nothing due" hint="No tracked bills fall in this window." />;
  }
  return (
    <Card className="!p-0">
      <ul className="divide-y divide-border">
        {items.map((s) => {
          const overdue = s.due_in_days < 0;
          const drift = priceChangeLine(s);
          return (
            <li key={s.id}>
              <Pressable
                onClick={() => onOpen(s)}
                className="w-full min-h-11 p-4 flex items-start justify-between gap-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm font-medium tracking-[-0.01em] truncate">{scheduleName(s)}</p>
                    {s.missed && <Pill>Missed</Pill>}
                    {s.price_change && !s.missed && <Pill>Price change</Pill>}
                  </div>
                  <p className={`font-mono text-[10px] tracking-[0.04em] mt-1 ${overdue ? "text-fg font-medium" : "text-muted"}`}>
                    {[dueLabel(s.due_in_days), shortDate(s.next_due), cadenceLabel(s.interval_days)].join(" · ")}
                  </p>
                  {drift && (
                    <p className="font-mono text-[10px] tracking-[0.04em] text-muted mt-0.5 tnum">{drift}</p>
                  )}
                </div>
                {/* Signed, not bare: the salary credit rendered identically to
                    a bill, so the biggest number in a list of "what you owe"
                    was money coming in. */}
                {(() => {
                  const amt = flowAmount(s.direction, s.amount_fils);
                  return (
                    <span
                      className="tnum text-sm font-medium shrink-0"
                      style={amt.flow === "in" ? { color: "var(--color-good)" } : undefined}
                      title={amt.flow === "in" ? "Money in" : "Money out"}
                    >
                      {amt.text}
                    </span>
                  );
                })()}
              </Pressable>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Recently paid bills — the "the email entered it for you" receipt. Each row
 * links to the matched transaction (evidence, one tap away).
 */
export function RecentlyPaidList({ schedules, onOpenMatch }: {
  schedules: Schedule[];
  onOpenMatch: (s: Schedule) => void;
}) {
  if (schedules.length === 0) return null;
  return (
    <Card className="!p-0">
      <ul className="divide-y divide-border">
        {schedules.map((s) => (
          <li key={s.id}>
            <Pressable
              onClick={() => onOpenMatch(s)}
              className="w-full min-h-11 p-4 flex items-center justify-between gap-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium tracking-[-0.01em] truncate">{scheduleName(s)}</p>
                <p className="font-mono text-[10px] tracking-[0.04em] text-muted mt-1">
                  {s.last_matched_at ? `paid ${shortDate(s.last_matched_at)}` : "paid"} · matched transaction ›
                </p>
              </div>
              <span className="tnum text-sm shrink-0 text-muted">
                <Money fils={s.last_amount_fils ?? s.amount_fils} />
              </span>
            </Pressable>
          </li>
        ))}
      </ul>
    </Card>
  );
}

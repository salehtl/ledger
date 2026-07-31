import { Card } from "../../components/ui/Card";
import { Pressable } from "../../components/ui/Pressable";
import { Pill } from "../../components/ui/Pill";
import { Money } from "../../components/Money";
import { cadenceLabel, scheduleName } from "../../lib/recurring";
import { shortDate } from "../../lib/format";
import type { Schedule } from "../../api/types";

/**
 * The full schedule inventory (active + paused), one calm row each: name,
 * cadence · next due, amount. Paused rows say so in a muted pill and drop the
 * next-due date (a paused bill has no next). The row tap opens the edit sheet,
 * which owns pause/resume/delete.
 */
export function ScheduleList({ schedules, onOpen }: {
  schedules: Schedule[];
  onOpen: (s: Schedule) => void;
}) {
  return (
    <Card className="!p-0">
      <ul className="divide-y divide-border">
        {schedules.map((s) => {
          const paused = s.status === "paused";
          const meta = paused
            ? [cadenceLabel(s.interval_days), s.source === "detected" ? "detected" : "manual"].join(" · ")
            : [cadenceLabel(s.interval_days), `next ${shortDate(s.next_due)}`, s.source === "detected" ? "detected" : "manual"].join(" · ");
          return (
            <li key={s.id}>
              <Pressable
                onClick={() => onOpen(s)}
                className="w-full min-h-11 p-4 flex items-center justify-between gap-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className={`text-sm font-medium tracking-[-0.01em] truncate ${paused ? "text-muted" : ""}`}>
                      {scheduleName(s)}
                    </p>
                    {paused && <Pill tone="muted">Paused</Pill>}
                  </div>
                  <p className="font-mono text-[10px] tracking-[0.04em] text-muted mt-1">{meta}</p>
                </div>
                <span className={`tnum text-sm shrink-0 ${paused ? "text-muted" : "font-medium"}`}>
                  <Money fils={s.amount_fils} />
                </span>
              </Pressable>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

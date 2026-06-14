// frontend/src/views/Dashboard.tsx
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Summary } from "../api/types";
import { BucketBox } from "../components/BucketBox";
import { Money } from "../components/Money";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";

export function Dashboard() {
  const q = useQuery({ queryKey: ["summary"], queryFn: () => getJSON<Summary>("/api/summary?period=current") });
  if (q.isLoading) return <Skeleton rows={6} />;
  if (q.error) return <EmptyState icon="alert" title="Couldn't load summary" hint="Check your connection and try again." />;
  const s = q.data!;
  const monthPct = Math.round(s.month_progress * 100);
  return (
    <div>
      <header className="dash-header">
        <Icon name="money" size={28} alt="" />
        <div>
          <div className="dash-income"><Money fils={s.income} /></div>
          <small className="muted">Income · {s.period}</small>
        </div>
      </header>

      {s.buckets.map((b) => <BucketBox key={b.bucket} b={b} />)}

      <fieldset>
        <legend>Month progress</legend>
        <div className="bar"><div className="bar-fill bar-green" style={{ width: `${monthPct}%` }} /></div>
        <small>{monthPct}% of the month elapsed</small>
      </fieldset>

      <fieldset>
        <legend>Recent</legend>
        {s.recent.length === 0 ? (
          <EmptyState title="No recent activity" hint="New transactions will appear here." />
        ) : (
          <ul className="recent">
            {s.recent.map((t) => (
              <li key={t.ID} className="recent-row">
                <span>{t.MerchantRaw || "—"}</span>
                <Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} />
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </div>
  );
}

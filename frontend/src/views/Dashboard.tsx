import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Summary } from "../api/types";
import { BucketBox } from "../components/BucketBox";
import { Money } from "../components/Money";

export function Dashboard() {
  const q = useQuery({ queryKey: ["summary"], queryFn: () => getJSON<Summary>("/api/summary?period=current") });
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p>Could not load summary.</p>;
  const s = q.data!;
  const monthPct = Math.round(s.month_progress * 100);
  return (
    <div>
      <p>Income <Money fils={s.income} /> · {s.period}</p>
      {s.buckets.map((b) => <BucketBox key={b.bucket} b={b} />)}
      <fieldset>
        <legend>Month progress</legend>
        <div className="bar"><div className="bar-fill bar-green" style={{ width: `${monthPct}%` }} /></div>
        <small>{monthPct}% of the month elapsed</small>
      </fieldset>
      <fieldset>
        <legend>Recent</legend>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {s.recent.map((t) => (
            <li key={t.ID} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span>{t.MerchantRaw || "—"}</span>
              <Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} />
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}

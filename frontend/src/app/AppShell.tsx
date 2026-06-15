import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Txn } from "../api/types";
import { BottomNav } from "../components/ui/BottomNav";
import { type TabId } from "./nav";
import { useOnline } from "../hooks/useOnline";
import { useLiveEvents } from "../hooks/useLiveEvents";
import { Home } from "../screens/Home";
import { Transactions } from "../screens/Transactions";

// Phase B placeholder — replaced by real screens in Phases C–F.
function Placeholder({ title }: { title: string }) {
  return <h1 className="text-xl font-semibold">{title}</h1>;
}

export function AppShell() {
  const [tab, setTab] = useState<TabId>("home");
  const online = useOnline();
  useLiveEvents();

  const review = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });
  const reviewCount = review.data?.length ?? 0;

  return (
    <div className="min-h-[100dvh] flex flex-col">
      {!online && (
        <div role="status" className="bg-warn/15 text-warn text-sm text-center py-1">Offline — showing last loaded data</div>
      )}
      <main className="flex-1 max-w-screen-sm w-full mx-auto px-4 pt-4 pb-24">
        {tab === "home" && <Home />}
        {tab === "transactions" && <Transactions />}
        {tab === "insights" && <Placeholder title="Insights" />}
        {tab === "settings" && <Placeholder title="Settings" />}
      </main>
      <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />
    </div>
  );
}

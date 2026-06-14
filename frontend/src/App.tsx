import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "./api/client";
import type { Txn } from "./api/types";
import { AppWindow } from "./components/AppWindow";
import { Taskbar } from "./components/Taskbar";
import type { Tab } from "./components/Taskbar";
import { Dashboard } from "./views/Dashboard";
import { Review } from "./views/Review";
import { Transactions } from "./views/Transactions";
import { SettingsDrawer } from "./views/SettingsDrawer";
import { useLiveEvents } from "./hooks/useLiveEvents";
import { useOnline } from "./hooks/useOnline";

const TITLES: Record<Tab, string> = {
  dashboard: "Dashboard",
  review: "Review",
  transactions: "History",
};

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);
  const online = useOnline();
  useLiveEvents();

  const review = useQuery({
    queryKey: ["review"],
    queryFn: () => getJSON<Txn[]>("/api/review"),
  });

  return (
    <>
      <AppWindow title={TITLES[tab]} online={online}>
        {tab === "dashboard" && <Dashboard />}
        {tab === "review" && <Review />}
        {tab === "transactions" && <Transactions />}
      </AppWindow>
      <Taskbar
        active={tab}
        reviewCount={review.data?.length ?? 0}
        onMenu={() => setMenuOpen(true)}
        onNavigate={setTab}
      />
      {menuOpen && <SettingsDrawer onClose={() => setMenuOpen(false)} />}
    </>
  );
}

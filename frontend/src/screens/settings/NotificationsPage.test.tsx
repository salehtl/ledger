import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast";
import { NotificationsPage } from "./NotificationsPage";

let putStatus: number;
let puts: unknown[];

beforeEach(() => {
  putStatus = 200;
  puts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/notifications" && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(putStatus === 200 ? JSON.parse(String(init.body)) : { error: "bad" }), { status: putStatus });
    }
    if (url === "/api/settings/notifications") {
      return new Response(JSON.stringify({ notify_thresholds: true, notify_upcoming_days: 3 }));
    }
    return new Response("{}", { status: 404 });
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <NotificationsPage onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("NotificationsPage", () => {
  it("loads current settings into the controls", async () => {
    wrap();
    const toggle = await screen.findByRole("checkbox", { name: "Budget threshold alerts" });
    expect(toggle).toBeChecked();
    expect(screen.getByLabelText("Upcoming-bill window")).toHaveValue("3");
  });

  it("autosaves a threshold toggle via PUT", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Budget threshold alerts" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ notify_thresholds: false, notify_upcoming_days: 3 });
  });

  it("autosaves the upcoming-days window via PUT", async () => {
    wrap();
    fireEvent.change(await screen.findByLabelText("Upcoming-bill window"), { target: { value: "7" } });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ notify_thresholds: true, notify_upcoming_days: 7 });
  });

  it("reports a failed save and refetches", async () => {
    putStatus = 500;
    wrap();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Budget threshold alerts" }));
    expect(await screen.findByText("Couldn't save notification settings")).toBeInTheDocument();
  });
});

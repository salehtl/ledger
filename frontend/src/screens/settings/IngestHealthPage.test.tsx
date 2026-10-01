import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../components/Toast";
import { IngestHealthPage } from "./IngestHealthPage";

const settingsPayload = {
  auto_categorize: true, ai_enabled: false, ai_auto_accept: false,
  ai_threshold: 0.85, ingest_silence_days: 3, ai_key_present: false,
};

const warnHealth = {
  status: "ok", db: "ok",
  ingest: {
    configured: true, count: 42, last_at: "2026-07-01T08:00:00Z",
    status: "warn", reasons: ["mail_silent"],
    last_poll_success_at: "2026-07-05T11:00:00Z",
    last_poll_attempt_at: "2026-07-05T11:59:00Z",
    consecutive_failures: 0, poll_interval_seconds: 60, silence_days: 3,
    unread: { transaction: 3, not_transaction: 1, unchecked: 0, set_aside: 12 },
  },
};

let putBodies: string[];
let health: unknown;

beforeEach(() => {
  putBodies = [];
  health = warnHealth;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/health")) return new Response(JSON.stringify(health));
    if (u.includes("/api/settings")) {
      if (init?.method === "PUT") {
        putBodies.push(String(init.body));
        return new Response("{}");
      }
      return new Response(JSON.stringify(settingsPayload));
    }
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider><IngestHealthPage onClose={() => {}} /></ToastProvider>
    </QueryClientProvider>,
  );
}

describe("IngestHealthPage", () => {
  it("shows the status headline, reason, and facts", async () => {
    wrap();
    expect(await screen.findByText("Warning")).toBeInTheDocument();
    expect(screen.getByText(/no bank email/i)).toBeInTheDocument(); // mail_silent reason copy
    expect(screen.getByText(/last email seen/i)).toBeInTheDocument();
    expect(screen.getByText(/last successful check/i)).toBeInTheDocument();
  });

  it("shows the emails no parser read", async () => {
    wrap();
    expect(await screen.findByText("Emails no parser read")).toBeInTheDocument();
    expect(screen.getByText("Look like transactions")).toBeInTheDocument();
    expect(screen.getByText("Set aside as not transactions")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    // The periodic hook gives an email 3 attempts, and a check skipped while
    // AI is off uses one. The hint must not promise every email gets checked.
    expect(screen.getByText(
      "AI checks new emails while AI features are on. Emails that came in while AI was off stay unchecked. A transaction here needs a parser update.",
    )).toBeInTheDocument();
  });

  it("hides the card when health has no unread counts", async () => {
    const { unread: _unread, ...ingest } = warnHealth.ingest;
    health = { ...warnHealth, ingest };
    wrap();
    expect(await screen.findByText("Warning")).toBeInTheDocument();
    expect(screen.queryByText("Emails no parser read")).toBeNull();
  });

  it("saves the silence threshold with all writable fields", async () => {
    wrap();
    await screen.findByText("Warning");
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(putBodies.length).toBe(1));
    const body = JSON.parse(putBodies[0]);
    expect(body.ingest_silence_days).toBe(7);
    expect(body.auto_categorize).toBe(true);   // other settings preserved
    expect(body.ai_threshold).toBe(0.85);
  });
});

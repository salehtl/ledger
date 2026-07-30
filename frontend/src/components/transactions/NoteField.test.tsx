// frontend/src/components/transactions/NoteField.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NoteField } from "./NoteField";

let calls: { url: string; method?: string; body?: string }[];
let failNext: boolean;

beforeEach(() => {
  calls = [];
  failNext = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string });
    if (failNext) return new Response(JSON.stringify({ error: "db error" }), { status: 500 });
    return new Response(JSON.stringify({ ok: true }));
  }));
});

afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("NoteField", () => {
  it("shows the label and the existing memo", () => {
    wrap(<NoteField txnId={9} initial="team lunch" />);
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByLabelText(/note/i)).toHaveValue("team lunch");
  });

  it("saves the trimmed note on blur and reports it", async () => {
    wrap(<NoteField txnId={9} initial="" />);
    const input = screen.getByLabelText(/note/i);
    fireEvent.change(input, { target: { value: "  split with sara  " } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    expect(calls).toEqual([
      { url: "/api/transactions/9/note", method: "PUT", body: JSON.stringify({ note: "split with sara" }) },
    ]);
  });

  it("saves on Enter via blur", async () => {
    wrap(<NoteField txnId={9} initial="" />);
    const input = screen.getByLabelText(/note/i);
    fireEvent.change(input, { target: { value: "memo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input); // jsdom does not blur on its own
    await waitFor(() => expect(calls.length).toBe(1));
  });

  it("does not save when the text is unchanged", () => {
    wrap(<NoteField txnId={9} initial="same" />);
    const input = screen.getByLabelText(/note/i);
    fireEvent.blur(input);
    expect(calls).toEqual([]);
  });

  it("clears the memo with an empty save", async () => {
    wrap(<NoteField txnId={9} initial="old" />);
    const input = screen.getByLabelText(/note/i);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body).toBe(JSON.stringify({ note: "" }));
  });

  it("keeps the typed text and says so when the save fails", async () => {
    failNext = true;
    wrap(<NoteField txnId={9} initial="" />);
    const input = screen.getByLabelText(/note/i);
    fireEvent.change(input, { target: { value: "memo" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/couldn't save/i));
    expect(input).toHaveValue("memo");
  });
});

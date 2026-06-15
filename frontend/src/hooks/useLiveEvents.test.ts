import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { LIVE_INVALIDATE_KEYS, useLiveEvents } from "./useLiveEvents";

// Minimal EventSource stand-in: jsdom has none. Captures listeners so the test
// can dispatch SSE messages and assert query invalidation.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners[type] ?? []) fn({ data } as MessageEvent);
  }
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

describe("useLiveEvents", () => {
  it("exposes the live-data query keys", () => {
    expect(LIVE_INVALIDATE_KEYS).toEqual([["summary"], ["transactions"], ["review"], ["insights-categories"], ["insights-trend"]]);
  });

  it("invalidates the live keys on a default (unnamed) SSE message", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useLiveEvents(), { wrapper });

    FakeEventSource.last!.emit("message", JSON.stringify({ type: "new_transaction", data: {} }));
    expect(spy).toHaveBeenCalledTimes(LIVE_INVALIDATE_KEYS.length);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["summary"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["insights-categories"] });
  });

  it("ignores drift_alert messages (no view data)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useLiveEvents(), { wrapper });

    FakeEventSource.last!.emit("message", JSON.stringify({ type: "drift_alert", data: [] }));
    expect(spy).not.toHaveBeenCalled();
  });
});

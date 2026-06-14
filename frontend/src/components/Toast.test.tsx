import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { toastReducer, ToastProvider, useToast } from "./Toast";

describe("toastReducer", () => {
  it("adds and removes by id", () => {
    const added = toastReducer([], { type: "add", toast: { id: 1, message: "Hi" } });
    expect(added).toHaveLength(1);
    const removed = toastReducer(added, { type: "remove", id: 1 });
    expect(removed).toHaveLength(0);
  });
});

function Trigger() {
  const { show } = useToast();
  const onUndo = vi.fn();
  // expose the spy so the test can assert it fired
  (globalThis as Record<string, unknown>).__undo = onUndo;
  return (
    <button onClick={() => show({ message: "Ignored Spinneys", action: { label: "Undo", onAction: onUndo } })}>
      go
    </button>
  );
}

describe("ToastProvider", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows a toast and fires its action", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("Ignored Spinneys")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect((globalThis as Record<string, unknown>).__undo).toBeTruthy();
    expect(((globalThis as unknown as Record<string, () => void> & { __undo: ReturnType<typeof vi.fn> }).__undo)).toHaveBeenCalled();
  });
});

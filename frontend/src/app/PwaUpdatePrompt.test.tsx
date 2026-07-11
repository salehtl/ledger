import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToastProvider } from "../components/Toast";
import { PwaUpdatePrompt } from "./PwaUpdatePrompt";
import type { useRegisterSW } from "virtual:pwa-register/react";

// Build a fake useRegisterSW returning a controllable needRefresh + spy updater.
function fakeRegister(needRefresh: boolean, update = vi.fn()): typeof useRegisterSW {
  return () => ({
    needRefresh: [needRefresh, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: update,
  });
}

describe("PwaUpdatePrompt", () => {
  it("shows nothing when no update is waiting", () => {
    render(
      <ToastProvider>
        <PwaUpdatePrompt useRegister={fakeRegister(false)} />
      </ToastProvider>,
    );
    expect(screen.queryByText(/new version/i)).toBeNull();
  });

  it("shows a refresh toast when an update is waiting, and Refresh triggers the update", () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <PwaUpdatePrompt useRegister={fakeRegister(true, update)} />
      </ToastProvider>,
    );
    expect(screen.getByText(/new version is available/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(update).toHaveBeenCalledWith(true);
  });
});

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

function renderPage(onClose = vi.fn()) {
  render(
    <SettingsPage title="Budget" onClose={onClose}>
      <p>body</p>
    </SettingsPage>,
  );
  return onClose;
}

afterEach(() => vi.restoreAllMocks());

describe("SettingsPage swipe-back", () => {
  it("pops the page after a committing edge drag", async () => {
    const onClose = renderPage();
    const strip = screen.getByTestId("edge-back-strip");
    fireEvent.pointerDown(strip, { clientX: 10, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 400, clientY: 300, pointerId: 1 });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("springs back without closing on a short slow drag", () => {
    // Script the clock: pointerDown reads Date.now() once (start), pointerUp
    // once (elapsed). 50px over 1000ms is below both distance and velocity
    // thresholds — jsdom's real timestamps would fake a lightning flick.
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1000);
    const onClose = renderPage();
    const strip = screen.getByTestId("edge-back-strip");
    fireEvent.pointerDown(strip, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 60, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 60, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores drags that start outside the edge zone", () => {
    const onClose = renderPage();
    const strip = screen.getByTestId("edge-back-strip");
    fireEvent.pointerDown(strip, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 600, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("back arrow still closes (after the exit animation)", async () => {
    const onClose = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Back from Budget" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

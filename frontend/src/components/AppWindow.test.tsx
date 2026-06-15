import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppWindow } from "./AppWindow";

describe("AppWindow", () => {
  it("shows the title and no dead window controls", () => {
    render(<AppWindow title="Dashboard" online={true}>body</AppWindow>);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.queryByLabelText("Close")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Minimize")).not.toBeInTheDocument();
  });
  it("shows an offline indicator when disconnected", () => {
    render(<AppWindow title="Dashboard" online={false}>body</AppWindow>);
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });
});

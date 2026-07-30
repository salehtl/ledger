import "@/test/storybook";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./ScheduleForm.stories";

const { Create, Edit, EditPaused } = composeStories(stories);

describe("ScheduleForm stories", () => {
  it("create mode: labeled fields, no lifecycle controls", () => {
    render(<Create />);
    expect(screen.getByText("Add schedule")).toBeInTheDocument();
    expect(screen.getByText("Merchant")).toBeInTheDocument();
    expect(screen.getByText("Amount (AED)")).toBeInTheDocument();
    expect(screen.getByText("Repeats")).toBeInTheDocument();
    expect(screen.queryByText(/Pause tracking|Resume tracking/)).toBeNull();
  });

  it("create mode: validates through buildSchedulePayload and reports inline", () => {
    const onSubmit = vi.fn();
    render(<Create onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText("Add"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name or merchant.");
  });

  it("submits integer fils, never floats", () => {
    const onSubmit = vi.fn();
    const { container } = render(<Create onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. Gym Co"), { target: { value: "Gym Co" } });
    const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
    fireEvent.change(amount!, { target: { value: "250" } });
    fireEvent.click(screen.getByText("Add"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      merchant: "Gym Co",
      amount_fils: 25000,
      interval_days: 30,
    }));
  });

  it("edit mode opens pre-filled with lifecycle controls", () => {
    render(<Edit />);
    expect(screen.getByText("Edit schedule")).toBeInTheDocument();
    expect(screen.getByDisplayValue("gym co")).toBeInTheDocument();
    expect(screen.getByDisplayValue("250.00")).toBeInTheDocument();
    expect(screen.getByText("Pause tracking")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("paused schedules offer resume and explain the pause", () => {
    render(<EditPaused />);
    expect(screen.getByText("Resume tracking")).toBeInTheDocument();
    expect(screen.getByText(/stop matching emails/)).toBeInTheDocument();
  });

  it("delete requires a second tap", () => {
    const onDelete = vi.fn();
    render(<Edit onDelete={onDelete} />);
    fireEvent.click(screen.getByText("Delete schedule"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Tap again to delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("amount and custom-day inputs carry the right mobile keyboards", () => {
    const { container } = render(<Create />);
    expect(container.querySelector('input[inputmode="decimal"]')).not.toBeNull();
    const repeats = screen.getByText("Repeats").querySelector("select");
    fireEvent.change(repeats!, { target: { value: "custom" } });
    expect(container.querySelector('input[inputmode="numeric"]')).not.toBeNull();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddTransactionSheet } from "./AddTransactionSheet";
import type { Category } from "../../api/types";

const cats: Category[] = [{ ID: 3, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true }];

describe("AddTransactionSheet", () => {
  it("submits a built payload from valid input", () => {
    const onSubmit = vi.fn();
    render(<AddTransactionSheet categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/merchant/i), { target: { value: "Carrefour" } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "42.50" } });
    fireEvent.change(screen.getByLabelText(/^date$/i), { target: { value: "2026-06-15" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      amount_fils: 4250, direction: "debit", merchant_raw: "Carrefour", posted_at: "2026-06-15",
    }));
  });

  it("shows an error and does not submit when the merchant is blank", () => {
    const onSubmit = vi.fn();
    render(<AddTransactionSheet categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/merchant/i);
  });
});

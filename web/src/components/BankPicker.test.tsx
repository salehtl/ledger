import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MotionProvider } from "../app/MotionProvider";
import { BankPicker, bankRows } from "./BankPicker";

function mount(props: Partial<Parameters<typeof BankPicker>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <MotionProvider>
      <BankPicker supported={["adcb", "dib", "enbd"]} selected={["dib"]} onToggle={onToggle} {...props} />
    </MotionProvider>,
  );
  return { onToggle };
}

describe("bankRows", () => {
  it("keeps the server's order and appends anything declared it does not list", () => {
    // A waitlisted bank is declared and unsupported. Dropping it here would
    // leave the user with no row to press to remove it.
    expect(bankRows(["adcb", "dib"], ["dib", "mashreq"])).toEqual(["adcb", "dib", "mashreq"]);
  });

  it("does not repeat a bank that is both supported and declared", () => {
    expect(bankRows(["dib"], ["dib"])).toEqual(["dib"]);
  });
});

describe("BankPicker", () => {
  it("is a multi-select: every row is a checkbox, and more than one can be checked", () => {
    mount({ selected: ["dib", "enbd"] });
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    expect(boxes.filter((b) => b.getAttribute("aria-checked") === "true")).toHaveLength(2);
  });

  it("reports the state a row would move TO, so the caller never has to re-derive it", async () => {
    const user = userEvent.setup();
    const { onToggle } = mount();
    await user.click(screen.getByTestId("bank-row-enbd"));
    expect(onToggle).toHaveBeenCalledWith("enbd", true);
    await user.click(screen.getByTestId("bank-row-dib"));
    expect(onToggle).toHaveBeenCalledWith("dib", false);
  });

  it("shows a declared bank the server does not support, so it can be removed", () => {
    mount({ selected: ["mashreq"] });
    expect(screen.getByTestId("bank-row-mashreq")).toBeInTheDocument();
    expect(screen.getByTestId("bank-row-mashreq").getAttribute("aria-checked")).toBe("true");
  });

  it("names banks the way a person does, and an unknown id by its id rather than not at all", () => {
    mount({ supported: ["dib", "newbank"], selected: [] });
    expect(screen.getByText("Dubai Islamic Bank")).toBeInTheDocument();
    expect(screen.getByText("newbank")).toBeInTheDocument();
  });

  it("renders nothing at all rather than an empty frame when there is nothing to list", () => {
    mount({ supported: [], selected: [] });
    expect(screen.queryByTestId("bank-picker")).not.toBeInTheDocument();
  });
});

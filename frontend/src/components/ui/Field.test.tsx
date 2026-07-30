import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Search } from "./PixelIcon";
import { Input, NumberField, Select } from "./Field";

it("renders a 16px control (text-base) so iOS Safari doesn't zoom on focus", () => {
  render(<Input aria-label="Name" />);
  const el = screen.getByLabelText("Name");
  expect(el.className).toContain("text-base");
  expect(el.className).not.toContain("text-sm");
});

it("defaults to the surface background and switches to the inset surface on demand", () => {
  render(<Input aria-label="A" />);
  expect(screen.getByLabelText("A").className).toContain("bg-surface");
  render(<Input aria-label="B" inset />);
  expect(screen.getByLabelText("B").className).toContain("bg-surface-2");
});

it("renders a leading icon and pads the text clear of it", () => {
  render(<Input aria-label="Search" icon={Search} />);
  expect(screen.getByLabelText("Search").className).toContain("pl-9");
});

it("pads for text (no icon) instead", () => {
  render(<Input aria-label="Plain" />);
  expect(screen.getByLabelText("Plain").className).toContain("pl-3");
});

it("combines icon padding with the inset surface", () => {
  render(<Input aria-label="Inset Search" icon={Search} inset />);
  const el = screen.getByLabelText("Inset Search");
  expect(el.className).toContain("pl-9");
  expect(el.className).toContain("bg-surface-2");
});

it("spreads native props through (type, inputMode)", () => {
  render(<Input aria-label="Amount" type="number" inputMode="decimal" />);
  const el = screen.getByLabelText("Amount") as HTMLInputElement;
  expect(el.type).toBe("number");
  expect(el.inputMode).toBe("decimal");
});

describe("NumberField", () => {
  /**
   * A controlled host. `keepNull` is the difference between the two ways a
   * screen can use this: a required field ignores the null and keeps its last
   * good number, an optional one stores the null.
   */
  function Host({
    initial = 25000,
    onChange,
    keepNull = false,
    ...props
  }: {
    initial?: number | null;
    onChange?: (n: number | null) => void;
    keepNull?: boolean;
  } & Record<string, unknown>) {
    const [v, setV] = useState<number | null>(initial);
    return (
      <NumberField
        aria-label="Amount"
        value={v}
        onValueChange={(n) => {
          if (n !== null || keepNull) setV(n);
          onChange?.(n);
        }}
        {...props}
      />
    );
  }
  const field = () => screen.getByLabelText("Amount") as HTMLInputElement;

  // The bug this component exists to prevent.
  it("stays empty when cleared instead of forcing a 0 back in", () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    expect(field().value).toBe("25000");
    fireEvent.change(field(), { target: { value: "" } });
    expect(field().value).toBe("");
    expect(onChange).toHaveBeenCalledWith(null);
    expect(onChange).not.toHaveBeenCalledWith(0);
  });

  it("lets a fresh value be typed into the cleared field", () => {
    render(<Host />);
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.change(field(), { target: { value: "7" } });
    expect(field().value).toBe("7");
  });

  it("holds a half-typed decimal without rewriting it", () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "12" } });
    fireEvent.change(field(), { target: { value: "12." } });
    expect(field().value).toBe("12.");
    expect(onChange).toHaveBeenLastCalledWith(null); // "12." isn't a number yet
    fireEvent.change(field(), { target: { value: "12.5" } });
    expect(field().value).toBe("12.5");
    expect(onChange).toHaveBeenLastCalledWith(12.5);
  });

  it("ignores characters that aren't part of a number", () => {
    render(<Host />);
    fireEvent.change(field(), { target: { value: "12abc" } });
    expect(field().value).toBe("12");
    expect(field().value).not.toMatch(/nan/i);
  });

  it("restores the committed value when blurred while empty", () => {
    render(<Host initial={40} />);
    fireEvent.change(field(), { target: { value: "" } });
    expect(field().value).toBe("");
    fireEvent.blur(field());
    expect(field().value).toBe("40");
  });

  it("can be left empty when the caller stores the null", () => {
    const onChange = vi.fn();
    render(<Host initial={40} allowEmpty keepNull onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(field().value).toBe("");
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("never reports 0 for an empty field, so autosave can't persist a bogus zero", () => {
    const onChange = vi.fn();
    render(<Host initial={25000} onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "" } });
    expect(onChange.mock.calls.flat()).not.toContain(0);
    // Typing a real zero still reports a real zero.
    fireEvent.change(field(), { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("clamps into range on blur, not while typing", () => {
    const onChange = vi.fn();
    render(<Host initial={50} min={0} max={100} onChange={onChange} />);
    fireEvent.change(field(), { target: { value: "150" } });
    expect(field().value).toBe("150"); // not yanked mid-keystroke
    fireEvent.blur(field());
    expect(field().value).toBe("100");
  });

  it("rejects a minus sign unless negatives are allowed", () => {
    render(<Host initial={5} />);
    fireEvent.change(field(), { target: { value: "-5" } });
    expect(field().value).toBe("5");
  });

  it("renders 16px text so iOS doesn't zoom, and uses a numeric keypad", () => {
    render(<Host />);
    expect(field().className).toContain("text-base");
    expect(field().inputMode).toBe("decimal");
  });

  it("shows an empty box for a null value rather than 0", () => {
    render(<Host initial={null} />);
    expect(field().value).toBe("");
  });
});

it("Select keeps the 16px base and spreads props", () => {
  render(
    <Select aria-label="Kind" defaultValue="income">
      <option value="spending">spending</option>
      <option value="income">income</option>
    </Select>,
  );
  const el = screen.getByLabelText("Kind") as HTMLSelectElement;
  expect(el.className).toContain("text-base");
  expect(el.value).toBe("income");
});

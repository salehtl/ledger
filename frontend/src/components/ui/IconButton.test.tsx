import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MotionProvider } from "../../app/MotionProvider";
import { Trash2 } from "./PixelIcon";
import { IconButton } from "./IconButton";
import * as haptics from "../../lib/haptics";

afterEach(() => vi.restoreAllMocks());

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

it("meets the 44px touch target by default and exposes its label", () => {
  wrap(<IconButton label="Delete"><Trash2 size={16} /></IconButton>);
  const btn = screen.getByRole("button", { name: "Delete" });
  expect(btn.className).toContain("min-w-11");
  expect(btn.className).toContain("min-h-11");
  // Regression guard for the unlayered `.press` cascade bug: the class must
  // never come back. Pressable.test.tsx covers the actual whileTap behavior.
  expect(btn.className).not.toContain("press");
});

it("offers a 36px size for dense stacked rows only", () => {
  wrap(<IconButton label="Archive" size="sm"><Trash2 size={16} /></IconButton>);
  const btn = screen.getByRole("button", { name: "Archive" });
  expect(btn.className).toContain("w-9");
  expect(btn.className).toContain("h-9");
});

it("fires a selection haptic and still calls onClick when tapped", () => {
  const fire = vi.spyOn(haptics, "fire");
  const onClick = vi.fn();
  wrap(<IconButton label="Go" onClick={onClick}><Trash2 size={16} /></IconButton>);
  screen.getByRole("button", { name: "Go" }).click();
  expect(fire).toHaveBeenCalledWith("selection");
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("does not fire when disabled", () => {
  const fire = vi.spyOn(haptics, "fire");
  const onClick = vi.fn();
  wrap(<IconButton label="Nope" disabled onClick={onClick}><Trash2 size={16} /></IconButton>);
  screen.getByRole("button", { name: "Nope" }).click();
  expect(fire).not.toHaveBeenCalled();
  expect(onClick).not.toHaveBeenCalled();
});

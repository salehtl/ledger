import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MotionProvider } from "../../app/MotionProvider";
import { Button } from "./Button";
import * as haptics from "../../lib/haptics";

afterEach(() => vi.restoreAllMocks());

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

it("gets its press feedback from the shared Pressable primitive, not a bare CSS class", () => {
  // Regression guard for the unlayered `.press` cascade bug: the class must
  // never come back. Pressable.test.tsx covers the actual whileTap behavior.
  wrap(<Button>Save</Button>);
  expect(screen.getByRole("button", { name: "Save" }).className).not.toContain("press");
});

it("fires a selection haptic and still calls onClick when tapped", () => {
  const fire = vi.spyOn(haptics, "fire");
  const onClick = vi.fn();
  wrap(<Button onClick={onClick}>Save</Button>);
  screen.getByRole("button", { name: "Save" }).click();
  expect(fire).toHaveBeenCalledWith("selection");
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("does not fire a haptic when disabled", () => {
  const fire = vi.spyOn(haptics, "fire");
  wrap(<Button disabled>Save</Button>);
  screen.getByRole("button", { name: "Save" }).click();
  expect(fire).not.toHaveBeenCalled();
});

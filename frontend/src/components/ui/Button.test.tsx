import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "./Button";
import * as haptics from "../../lib/haptics";

afterEach(() => vi.restoreAllMocks());

it("applies press-feedback class for tactile :active scaling", () => {
  render(<Button>Save</Button>);
  expect(screen.getByRole("button", { name: "Save" }).className).toContain("press");
});

it("fires a selection haptic and still calls onClick when tapped", () => {
  const fire = vi.spyOn(haptics, "fire");
  const onClick = vi.fn();
  render(<Button onClick={onClick}>Save</Button>);
  screen.getByRole("button", { name: "Save" }).click();
  expect(fire).toHaveBeenCalledWith("selection");
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("does not fire a haptic when disabled", () => {
  const fire = vi.spyOn(haptics, "fire");
  render(<Button disabled>Save</Button>);
  screen.getByRole("button", { name: "Save" }).click();
  expect(fire).not.toHaveBeenCalled();
});

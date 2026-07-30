import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { Pressable } from "./Pressable";

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

describe("Pressable", () => {
  it("defaults to type=button so it never submits an enclosing form", () => {
    wrap(<Pressable>Save</Pressable>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });

  it("lets the caller override the type", () => {
    wrap(<Pressable type="submit">Go</Pressable>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "submit");
  });

  it("forwards clicks", () => {
    const onClick = vi.fn();
    wrap(<Pressable onClick={onClick}>Tap</Pressable>);
    fireEvent.click(screen.getByRole("button", { name: "Tap" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("merges the caller's className rather than replacing it", () => {
    wrap(<Pressable className="text-accent">Tap</Pressable>);
    expect(screen.getByRole("button", { name: "Tap" }).className).toContain("text-accent");
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    wrap(<Pressable disabled onClick={onClick}>Tap</Pressable>);
    fireEvent.click(screen.getByRole("button", { name: "Tap" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

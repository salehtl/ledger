import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./InfoTip.stories";

const { Default, AlignedEnd } = composeStories(stories);

describe("InfoTip stories", () => {
  it("names its subject on the trigger and opens on tap", async () => {
    const user = userEvent.setup();
    render(<Default />);
    const trigger = screen.getByRole("button", { name: "About the signing domain" });
    await user.click(trigger);
    expect(await screen.findByRole("note")).toHaveTextContent(/cryptographically signed/i);
  });

  it("anchors to the right edge when asked", async () => {
    const user = userEvent.setup();
    render(<AlignedEnd />);
    await user.click(screen.getByRole("button", { name: "About held mail" }));
    expect((await screen.findByRole("note")).className).toMatch(/\bright-0\b/);
  });
});

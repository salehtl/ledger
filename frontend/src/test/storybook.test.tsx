import "@/test/storybook";
import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";

// Eagerly import every story module in the repo. New story files join the
// net automatically; a story that throws on render fails the build.
const modules = import.meta.glob<Record<string, unknown>>("../**/*.stories.tsx", { eager: true });

describe("every story renders", () => {
  for (const [path, mod] of Object.entries(modules)) {
    describe(path, () => {
      const composed = composeStories(mod as never);
      for (const [name, Story] of Object.entries(composed) as [string, React.ComponentType][]) {
        it(name, () => {
          const { container } = render(<Story />);
          expect(container.firstChild).not.toBeNull();
          cleanup();
        });
      }
    });
  }
});

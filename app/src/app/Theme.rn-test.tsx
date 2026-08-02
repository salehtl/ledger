/**
 * The component-test runner's own proof that it works, plus the two properties
 * of the shell that a pure test cannot see.
 *
 * Named `.rn-test.tsx` rather than `.test.tsx`: `bun test` cannot render
 * anything that imports `react-native` (Flow in RN's entry point), so the two
 * runners are separated by file pattern instead of by hope. See
 * `jest.config.js`.
 */

import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { Shell } from "../screens/Shell.tsx";
import { palettes, ThemeProvider, TOUCH_TARGET_MIN, type, useTheme } from "./Theme.tsx";

function ShowsScheme() {
  const t = useTheme();
  return <Text>{`${t.scheme}:${t.colors.bg}`}</Text>;
}

describe("Theme", () => {
  // `render` is async in @testing-library/react-native 14 — it awaits `act`
  // internally. Forgetting the await does not fail loudly: `screen` is still
  // the un-rendered default and every query throws "`render` function has not
  // been called", which reads like a setup problem rather than a missing await.
  it("renders under the provider", async () => {
    await render(
      <ThemeProvider>
        <ShowsScheme />
      </ThemeProvider>,
    );
    // The test environment reports no colour scheme, which maps to light.
    expect(screen.getByText(`light:${palettes.light.bg}`)).toBeTruthy();
  });

  it("throws outside the provider rather than falling back to a default", async () => {
    // A silent default is how a screen renders in the wrong scheme and nobody
    // notices until a screenshot.
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      render(<ShowsScheme />),
    ).rejects.toThrow(/useTheme\(\) outside/);
    quiet.mockRestore();
  });

  it("keeps the two conventions that are not taste", () => {
    expect(TOUCH_TARGET_MIN).toBe(44);
    expect(type.input.fontSize).toBeGreaterThanOrEqual(16);
  });
});

describe("Shell", () => {
  /**
   * The one thing this proves that nothing else does: a **component** can
   * import `@ledger/client` and the code behind it runs. `bun test` proves the
   * modules work; `bun run bundle` proves Metro resolves them; this proves the
   * React tree can actually call into them, with the seam installed the way
   * `jest.setup.js` installs it.
   */
  it("reports both seams live", async () => {
    await render(
      <ThemeProvider>
        <Shell />
      </ThemeProvider>,
    );
    expect(screen.getByText("client/src is wired")).toBeTruthy();
    expect(screen.getByText(/ok — platform seam/)).toBeTruthy();
    expect(screen.getByText(/ok — replay fold/)).toBeTruthy();
  });
});

import { scrubIntent, SCRUB_SLOP } from "./chartScrub";
import { pullIntent } from "./pullToRefresh";

describe("scrubIntent", () => {
  it("waits inside the slop zone rather than guessing from the first pixel", () => {
    expect(scrubIntent(0, 0)).toBe("undecided");
    expect(scrubIntent(SCRUB_SLOP, SCRUB_SLOP)).toBe("undecided");
    expect(scrubIntent(-SCRUB_SLOP, 0)).toBe("undecided");
  });

  it("claims a clearly horizontal drag, either direction", () => {
    expect(scrubIntent(20, 2)).toBe("claim");
    expect(scrubIntent(-20, 2)).toBe("claim");
  });

  it("rejects a clearly vertical drag so the page scrolls", () => {
    expect(scrubIntent(2, 20)).toBe("reject");
    expect(scrubIntent(2, -20)).toBe("reject"); // upward too — that's a scroll
  });

  it("gives ties to scrolling", () => {
    // A page that won't scroll reads as broken; a scrub you retry does not.
    expect(scrubIntent(20, 20)).toBe("reject");
    expect(scrubIntent(-20, -20)).toBe("reject");
  });

  it("never claims a gesture pullIntent also claims", () => {
    // Both run on the same finger. If they could both claim, a downward drag
    // over a chart would scrub and pull at once.
    for (let dx = -40; dx <= 40; dx += 2) {
      for (let dy = -40; dy <= 40; dy += 2) {
        const bothClaim = scrubIntent(dx, dy) === "claim" && pullIntent(dx, dy) === "claim";
        expect(bothClaim).toBe(false);
      }
    }
  });

  it("decides over the same distance pullIntent does, so neither wins by twitchiness", () => {
    expect(scrubIntent(SCRUB_SLOP + 1, 0)).toBe("claim");
    expect(pullIntent(0, SCRUB_SLOP + 1)).toBe("claim");
  });
});

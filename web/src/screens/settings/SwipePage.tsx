import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Field";
import { ArrowLeft, ArrowRight, ArrowUp, ArrowDown, type PixelIconType } from "../../components/ui/PixelIcon";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import {
  loadSwipeConfig,
  saveSwipeConfig,
  DEFAULT_SWIPE_CONFIG,
  type SwipeConfig,
  type SwipeDirection,
} from "../../lib/swipe";

const SWIPE_DIRS: Record<SwipeDirection, { Icon: PixelIconType; word: string }> = {
  left: { Icon: ArrowLeft, word: "Left" },
  right: { Icon: ArrowRight, word: "Right" },
  up: { Icon: ArrowUp, word: "Up" },
  down: { Icon: ArrowDown, word: "Down" },
};

export function SwipePage({ onClose }: { onClose: () => void }) {
  const { saved, flash } = useSavedFlash();
  const [swipeCfg, setSwipeCfg] = useState<SwipeConfig>(loadSwipeConfig);

  const commit = (next: SwipeConfig) => {
    setSwipeCfg(next);
    saveSwipeConfig(next);
    flash();
  };

  /** The action a direction currently carries, as the option value shown in the UI. */
  const actionValue = (a: SwipeConfig[SwipeDirection]) => (a.bucket ? a.bucket : "transfer");

  const setSwipeDir = (dir: SwipeDirection, value: string) => {
    const template =
      value === "transfer"
        ? DEFAULT_SWIPE_CONFIG.up
        : Object.values(DEFAULT_SWIPE_CONFIG).find((a) => a.bucket === value);
    if (!template) return;

    // Swap, don't overwrite. The four directions are a mapping onto four
    // actions; assigning one direction an action another already held used to
    // leave two directions doing the same thing and one bucket unreachable in
    // Review — with no way to notice except that a bucket had quietly vanished.
    const next: SwipeConfig = { ...swipeCfg };
    const displaced = next[dir];
    const other = (Object.keys(next) as SwipeDirection[]).find(
      (d) => d !== dir && actionValue(next[d]) === value,
    );
    next[dir] = { ...template };
    if (other) next[other] = { ...displaced };
    commit(next);
  };

  return (
    <SettingsPage title="Swipe actions" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      <div>
        <p className="text-xs text-muted mb-3">What each swipe does when reviewing transactions.</p>
        <div className="space-y-2.5">
          {(["left", "right", "up", "down"] as const).map((dir) => {
            const current = swipeCfg[dir];
            const value = current.statusOverride === "transfer" ? "transfer" : current.bucket ?? "";
            const { Icon, word } = SWIPE_DIRS[dir];
            return (
              <div key={dir} className="flex items-center gap-3">
                <span className="w-9 h-9 grid place-items-center rounded-[var(--radius)] bg-surface-2" aria-hidden><Icon size={16} /></span>
                <span className="text-sm w-12">{word}</span>
                <Select value={value} aria-label={`${word} swipe action`} onChange={(e) => setSwipeDir(dir, e.target.value)} className="flex-1">
                  <option value="want">Want</option>
                  <option value="need">Need</option>
                  <option value="saving">Save</option>
                  <option value="transfer">Transfer</option>
                </Select>
              </div>
            );
          })}
        </div>
        <Button variant="ghost" className="mt-3 text-sm" onClick={() => commit(DEFAULT_SWIPE_CONFIG)}>
          Reset to defaults
        </Button>
      </div>
    </SettingsPage>
  );
}

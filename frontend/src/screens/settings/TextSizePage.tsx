import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  applyFontScale,
  loadFontScale,
  saveFontScale,
  type FontScale,
} from "../../lib/fontScale";

const OPTIONS = FONT_SCALE_OPTIONS.map((n) => ({ value: String(n), label: `${n}%` }));

export function TextSizePage({ onClose }: { onClose: () => void }) {
  const { saved, flash } = useSavedFlash();
  const [scale, setScale] = useState<FontScale>(loadFontScale);

  const commit = (next: FontScale) => {
    setScale(next);
    applyFontScale(next);
    saveFontScale(next);
    flash();
  };

  return (
    <SettingsPage title="Text size" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      <div>
        <p className="text-xs text-muted mb-3">
          Scales all text in the app on this device. Applies immediately.
        </p>
        <div className="overflow-x-auto -mx-1 px-1">
          <SegmentedControl
            value={String(scale)}
            onChange={(v) => commit(Number(v) as FontScale)}
            options={OPTIONS}
          />
        </div>
        {scale !== DEFAULT_FONT_SCALE && (
          <Button variant="ghost" className="mt-3 text-sm" onClick={() => commit(DEFAULT_FONT_SCALE)}>
            Reset to default
          </Button>
        )}
      </div>
    </SettingsPage>
  );
}

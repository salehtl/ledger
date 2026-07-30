import { useRef } from "react";
import { Input } from "../../components/ui/Field";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import type { Sign } from "../../lib/reconcile";

/**
 * The balance amount control shared by check-in and tracking updates: a
 * persistent label, a +/− sign toggle (the decimal keyboard has no minus, and
 * credit cards owe), and a 16px decimal input. A sign typed into the text
 * itself wins over the toggle (see `composeStated`).
 */
export function BalanceField({ id, label, text, onText, sign, onSign, error, helper, autoFocus = false, onBlur }: {
  id: string;
  label: string;
  text: string;
  onText: (t: string) => void;
  sign: Sign;
  onSign: (s: Sign) => void;
  /** Inline validation message; input is preserved. */
  error?: string;
  /** Mono meta line under the field (expected balance, last update…). */
  helper?: string;
  autoFocus?: boolean;
  /** Fires when the amount input loses focus after the user edited it —
   *  callers gate the parse error on it so nothing flashes mid-entry
   *  ("8250." on the way to "8250.50"). Blurs before any edit are swallowed:
   *  the Dialog's mount focus steal must not count as a touch. */
  onBlur?: () => void;
}) {
  const dirty = useRef(false);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1.5">{label}</label>
      <div className="flex items-stretch gap-2">
        {/* preventDefault: SegmentedControl buttons carry no type attribute,
            so inside a form a sign tap would otherwise submit it. */}
        <div role="group" aria-label="Balance sign" className="shrink-0" onClick={(e) => e.preventDefault()}>
          <SegmentedControl<Sign>
            value={sign}
            onChange={onSign}
            options={[
              { value: "pos", label: "+" },
              { value: "neg", label: "−" },
            ]}
          />
        </div>
        <div className="flex-1 min-w-0">
          <Input
            id={id}
            inset
            type="text"
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            autoCorrect="off"
            autoFocus={autoFocus}
            placeholder="0.00"
            value={text}
            onChange={(e) => {
              dirty.current = true;
              onText(e.target.value);
            }}
            onBlur={() => {
              if (dirty.current) onBlur?.();
            }}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-bad">{error}</p>
      )}
      {helper && !error && (
        <p className="mt-1.5 font-mono text-[10px] tracking-[0.04em] text-muted tnum">{helper}</p>
      )}
    </div>
  );
}

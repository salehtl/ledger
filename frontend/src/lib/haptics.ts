// Device-local haptic feedback. Persisted per browser (localStorage, like the
// text scale) and fired synchronously from user-gesture handlers.
//
// Two primitives, matching the `web-haptics` technique without the dependency:
//   1. navigator.vibrate(pattern) — Android/Chrome; absent on iOS Safari.
//   2. iOS fallback — a hidden <label><input type="checkbox" switch></label>
//      that emits the system selection tick when clicked (iOS 17.4+).
//
// The iOS trick only fires when .click() runs inside an active user gesture and
// BEFORE any await, so every call site must fire() at the top of its handler.

const STORAGE_KEY = "ledger-haptics";

export type Haptic = "selection" | "light" | "success" | "warning";

export const HAPTIC_PATTERNS: Record<Haptic, number[]> = {
  selection: [10],
  light: [15],
  success: [12, 40, 20],
  warning: [20, 60, 20],
};

let enabled = true;

export function loadHapticsEnabled(): boolean {
  try {
    // Default on: only an explicit "false" disables.
    enabled = localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    enabled = true;
  }
  return enabled;
}

export function isHapticsEnabled(): boolean {
  return enabled;
}

export function setHapticsEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, String(on));
  } catch {
    // Storage unavailable (private mode): flag still applies this session.
  }
}

let iosSwitch: HTMLLabelElement | null = null;

/** Lazily create (once) the hidden iOS switch and return it, or null if no DOM. */
function ensureIosSwitch(): HTMLLabelElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  if (iosSwitch) return iosSwitch;
  const label = document.createElement("label");
  label.setAttribute("data-haptic-switch", "");
  label.setAttribute("aria-hidden", "true");
  label.style.cssText = "position:fixed;left:-9999px;pointer-events:none;";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  iosSwitch = label;
  return label;
}

/** Fire a haptic. No-op when disabled or unsupported. Call synchronously. */
export function fire(kind: Haptic) {
  if (!enabled) return;
  const vibrate = typeof navigator !== "undefined" ? navigator.vibrate : undefined;
  if (typeof vibrate === "function") {
    vibrate.call(navigator, HAPTIC_PATTERNS[kind]);
    return;
  }
  ensureIosSwitch()?.click();
}

import { useEffect, useRef } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { useToast } from "../components/Toast";

/**
 * Watches for a waiting service worker (registerType: "prompt") and shows a
 * sticky "New version — tap to refresh" toast. Tapping Refresh activates the
 * new worker and reloads. Renders nothing itself.
 *
 * The service-worker hook is injectable so the component can be tested without
 * the `virtual:pwa-register/react` module (which only exists under Vite).
 */
export function PwaUpdatePrompt({
  useRegister = useRegisterSW,
}: {
  useRegister?: typeof useRegisterSW;
} = {}) {
  const { show } = useToast();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegister();

  // Show the prompt once per waiting worker. needRefresh flips back to false
  // after updateServiceWorker(); this ref guards against a duplicate toast if
  // the effect re-runs while the flag is still true.
  const shownRef = useRef(false);
  useEffect(() => {
    if (!needRefresh) {
      shownRef.current = false;
      return;
    }
    if (shownRef.current) return;
    shownRef.current = true;
    show({
      message: "A new version is available.",
      tone: "info",
      sticky: true,
      action: { label: "Refresh", onAction: () => void updateServiceWorker(true) },
    });
  }, [needRefresh, show, updateServiceWorker]);

  return null;
}

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/app.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { ToastProvider } from "./components/Toast";
import { AppShell } from "./app/AppShell";
import { BootGate } from "./v2/BootGate";
import { Onboarding } from "./screens/onboarding/Onboarding";
import { Welcome } from "./screens/onboarding/Welcome";
import { MotionProvider } from "./app/MotionProvider";
import { applyFontScale, loadFontScale } from "./lib/fontScale";
import { loadHapticsEnabled, loadSoundEnabled } from "./lib/feedback";

// Apply the device's saved text scale before first paint so there's no flash
// of the wrong size.
applyFontScale(loadFontScale());

// Hydrate the haptics + sound on/off flags from localStorage before any interaction.
loadHapticsEnabled();
loadSoundEnabled();

/**
 * `QueryClientProvider`, NOT `PersistQueryClientProvider`.
 *
 * v1 persisted the react-query cache to `localStorage` so a cold offline
 * relaunch showed the last loaded data instead of an empty app. In v2 there is
 * nothing for it to do and two reasons it must not be here:
 *
 *  - The projection **is** the offline cache. It is SQLite in IndexedDB, it is
 *    written by the sync engine, and it survives a relaunch on its own. A
 *    second copy in `localStorage` would be a staler answer to a question that
 *    already has one.
 *  - Money is `int64` minor units carried as `bigint`, and the persister
 *    serialises with `JSON.stringify`, which **throws** on a `bigint`. Teaching
 *    it a replacer would be worse than the throw: it round-trips money back as
 *    a string, or — with a naive reviver — as a lossy `number`.
 *
 * `queryClient.ts` still exports `persister`; it is deliberately unmounted
 * rather than deleted while v1 screens are still routed (Tasks 8-10).
 */
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionProvider>
        <ToastProvider>
          {/*
            The gate's two slots, filled. Both take `done`, which re-runs boot
            from the top — the only way to re-derive the facts, and the reason
            neither screen has to tell the gate what it changed.
          */}
          <BootGate
            signIn={({ handle, done }) => <Welcome handle={handle} done={done} />}
            onboarding={({ handle, facts, done, sync }) => (
              <Onboarding handle={handle} facts={facts} done={done} sync={sync} />
            )}
          >
            <AppShell />
          </BootGate>
        </ToastProvider>
      </MotionProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

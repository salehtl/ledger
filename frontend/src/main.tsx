import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/app.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { queryClient, persister, PERSIST_MAX_AGE } from "./queryClient";
import { ToastProvider } from "./components/Toast";
import { AppShell } from "./app/AppShell";
import { applyFontScale, loadFontScale } from "./lib/fontScale";
import { loadHapticsEnabled, loadSoundEnabled } from "./lib/feedback";

// Apply the device's saved text scale before first paint so there's no flash
// of the wrong size.
applyFontScale(loadFontScale());

// Hydrate the haptics + sound on/off flags from localStorage before any interaction.
loadHapticsEnabled();
loadSoundEnabled();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: PERSIST_MAX_AGE }}
    >
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </PersistQueryClientProvider>
  </React.StrictMode>,
);

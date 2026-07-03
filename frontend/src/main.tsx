import "@fontsource-variable/inter";
import "@fontsource-variable/roboto-mono";
import "./styles/app.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { queryClient, persister, PERSIST_MAX_AGE } from "./queryClient";
import { ToastProvider } from "./components/Toast";
import { AppShell } from "./app/AppShell";

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

/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // Manifest icons are fetched by the OS at install time; don't precache them.
      includeManifestIcons: false,
      manifest: {
        name: "ledger",
        short_name: "ledger",
        description: "Personal budgeting",
        theme_color: "#fcf8f8",
        background_color: "#fcf8f8",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/manifest-icon-192.jpg", sizes: "192x192", type: "image/jpeg" },
          { src: "/manifest-icon-512.jpg", sizes: "512x512", type: "image/jpeg" },
          { src: "/manifest-icon-512.jpg", sizes: "512x512", type: "image/jpeg", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // Precache only what a cold offline start needs: app code + latin
        // fonts. Marketing/link-preview images and non-latin font subsets
        // (never fetched at runtime thanks to unicode-range) stay
        // network-served with cache headers.
        globPatterns: ["**/*.{js,css,html,woff2}"],
        globIgnores: [
          "assets/*-cyrillic*",
          "assets/*-greek*",
          "assets/*-vietnamese*",
          "assets/*-latin-ext-*",
        ],
      },
    }),
  ],
  build: { outDir: "../internal/web/dist", emptyOutDir: true },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Run test files sequentially in a single fork — the sandbox blocks
    // vitest's default parallel worker spawning, which otherwise silently
    // runs only the first file.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});

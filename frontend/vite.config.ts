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
      includeAssets: [
        "favicon.svg",
        "apple-touch-icon.jpg",
        "manifest-icon-192.jpg",
        "manifest-icon-512.jpg",
      ],
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
        globPatterns: ["**/*.{js,css,html,png,jpg,svg,woff2}"],
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

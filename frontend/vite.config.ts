/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Put a `<link rel="modulepreload">` for the Framer feature bundle in the HTML
 * head, so it downloads in parallel with the entry chunk instead of after it.
 *
 * Vite already rewrites `import("./motionFeatures")` through `__vitePreload`,
 * but that only fires when the thunk is *called* — and `LazyMotion` calls it
 * from a `useEffect`, i.e. after the first paint. That ordering is not
 * cosmetic: until the promise settles there is no animation feature loaded, so
 * every `m.*` renders straight from its `initial` prop. Content whose entrance
 * is deferred to JS therefore waits on a second network round trip that does
 * not even begin until the entry chunk has parsed, executed and painted.
 *
 * The components no longer put `opacity` in `initial` (see `screens/Home.tsx`),
 * so a slow chunk can no longer *hide* anything — this is belt and braces,
 * turning a serial fetch into a parallel one so the first stagger is not
 * skipped on a cold load.
 *
 * Matched on the chunk's `name`, which is the module basename and stable,
 * rather than on the hashed `fileName`.
 */
function preloadMotionFeatures(): Plugin {
  let base = "/";
  return {
    name: "ledger:preload-motion-features",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        const chunk = Object.values(ctx.bundle).find(
          (c) => c.type === "chunk" && c.name === "motionFeatures",
        );
        // Don't fail the build if the chunk is gone — the test in
        // styles/tokens.test.ts is what asserts it still exists.
        if (!chunk) return html;
        return {
          html,
          tags: [
            {
              tag: "link",
              attrs: { rel: "modulepreload", crossorigin: true, href: `${base}${chunk.fileName}` },
              injectTo: "head",
            },
          ],
        };
      },
    },
  };
}

export default defineConfig({
  // fileURLToPath, not `new URL(...).pathname`: the latter hands back a
  // percent-encoded, leading-slash URL path, which is wrong for any repo path
  // containing a space (or on Windows).
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    react(),
    tailwindcss(),
    preloadMotionFeatures(),
    VitePWA({
      // "prompt": a new service worker waits instead of silently taking over,
      // so PwaUpdatePrompt can offer a "New version — tap to refresh" toast.
      registerType: "prompt",
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
  // `bun run dev` serves the PWA but the API client uses relative /api URLs,
  // so point them at a running Go binary. LEDGER_API overrides the target for
  // the UI test harness, which runs the server on a scratch DB and free port.
  server: {
    proxy: {
      "/api": {
        target: process.env.LEDGER_API ?? "http://127.0.0.1:8080",
        changeOrigin: true,
        // /api/events is SSE: it must stream, never buffer to completion.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
            }
          });
        },
      },
    },
  },
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

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
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // `client/` is the framework-free local-first engine (Task 1+). Only
      // `@ledger/client/platform.web` may be imported from here — never
      // `@ledger/client/platform` (statically imports node:zlib/node:crypto)
      // or `@ledger/client/store/open` (pulls in bun:sqlite via ./driver).
      // Those would fail `bun run build`, not silently ship broken.
      //
      // `find` is a RegExp requiring a `/` right after `@ledger/client`, so
      // this matches subpaths only — same shape as tsconfig.json's
      // `"@ledger/client/*"` path mapping, and it does not also swallow a
      // hypothetical unrelated package like `@ledger/clientfoo`. A bare
      // `@ledger/client` import (no subpath) intentionally resolves nowhere
      // in either config, since nothing under `client/src` is meant to be
      // imported that way (there is no root barrel file).
      {
        find: /^@ledger\/client\//,
        replacement: `${fileURLToPath(new URL("../client/src", import.meta.url))}/`,
      },
    ],
  },
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
        // fonts + the sql.js wasm. Marketing/link-preview images and
        // non-latin font subsets (never fetched at runtime thanks to
        // unicode-range) stay network-served with cache headers.
        //
        // `wasm` is in this list, not just `js`: `web/src/v2/db/driver.ts`
        // imports `sql.js/dist/sql-wasm.wasm?url` so the ~660 KB binary is
        // fingerprinted like any other asset, but a fingerprinted asset is
        // only ACTUALLY offline-available once it is also in the precache
        // manifest — Workbox does not precache everything Rollup emits, only
        // what matches `globPatterns`. Without `wasm` here, the browser
        // SqlDriver has no database to open on a cold offline boot: the app
        // shell loads, but sql.js's own WASM fetch fails with no service
        // worker entry to serve it from.
        globPatterns: ["**/*.{js,css,html,woff2,wasm}"],
        globIgnores: [
          "assets/*-cyrillic*",
          "assets/*-greek*",
          "assets/*-vietnamese*",
          "assets/*-latin-ext-*",
        ],
      },
    }),
  ],
  // DECIDED 2026-08-07 (plan task D4): `ledgerd` embeds this bundle from
  // `internal/v2/webui` and serves it on the SAME listener as `/api/v1/*`, so
  // the PWA and the API share one origin — which is what lets WebAuthn run
  // with no CORS and no second hostname in `rp_origins`. Like v1's, the built
  // output is COMMITTED, because `//go:embed all:dist` fails the Go build
  // outright if the directory is absent.
  //
  // Still NOT `../internal/web/dist` — that is v1's committed embed artifact,
  // and a v2 build writing there would silently replace the bundle the
  // single-user instance serves from `main`. Keep these two trees apart.
  //
  // `LEDGER_WEB_OUT_DIR` overrides the destination, and exists for exactly one
  // caller: `scripts/v2-check.sh`. The gate runs `bun run build` because that is
  // the ONLY thing that exercises the two browser guards (`tsc -b` for a stray
  // `Bun.*`, Rollup for a `node:`/`bun:` import reaching the bundle) — but a
  // gate that rewrites a tracked artifact is a gate that dirties the tree on
  // every run, and the working copy then diverges from what is deployed with
  // nothing to show for it. Pointing the gate at a throwaway directory keeps
  // both guards running and leaves `dist` alone; the deploy step still builds
  // with no override and writes the committed artifact.
  build: { outDir: process.env.LEDGER_WEB_OUT_DIR ?? "../internal/v2/webui/dist", emptyOutDir: true },
  // `bun run dev` serves the PWA but the API client uses relative /api URLs,
  // so point them at a running Go binary. LEDGER_API overrides the target for
  // the UI test harness, which runs the server on a scratch DB and free port.
  //
  // `/api/v1` is `ledgerd` (v2) and `/api` is the v1 binary. The v1 key would
  // also match `/api/v1/...` — Vite walks the proxy table in key order and
  // takes the first prefix that matches — so the more specific one is FIRST,
  // and moving it below `/api` would silently send every v2 call to the
  // single-user server. LEDGER_V2_API overrides the target the same way
  // LEDGER_API does. In production both are same-origin and there is no proxy
  // at all, which is why the `Client`'s `server` is `""` in either case.
  server: {
    proxy: {
      "/api/v1": {
        target: process.env.LEDGER_V2_API ?? "http://127.0.0.1:8091",
        changeOrigin: true,
      },
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
    // Every file shares one process (see singleFork above), so a `vi.stubGlobal`
    // that is never undone leaks into whatever file vitest happens to schedule
    // next: ~20 files stub `fetch`, and a suite-order change alone was enough to
    // make an unrelated screen's tests time out against a stale mock. Restore
    // stubbed globals after each test so file order can't decide correctness.
    unstubGlobals: true,
    // Same reasoning for spies: 23 files vi.spyOn(api, …) and only some
    // restore. No file spies in beforeAll (verified), so per-test restoration
    // is safe. mocks created with vi.fn() in module scope are untouched.
    restoreMocks: true,
  },
});

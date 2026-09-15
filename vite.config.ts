import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      manifest: {
        name: "Khesh",
        short_name: "Khesh",
        description: "Offline-first household ledger using double-entry bookkeeping.",
        display: "standalone",
        lang: "en",
        dir: "ltr",
        theme_color: "#f7f5f2",
        background_color: "#f7f5f2",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        // Workbox's default is **/*.{js,wasm,css,html}, and this project had no
        // globPatterns at all, so the PWA icons were never actually precached and a
        // self-hosted font would not be either. This list is that default plus the
        // asset types the app really ships. Keep `wasm`: we replace the default rather
        // than extend it, so anything dropped here is dropped silently and for good.
        // Deliberately no `webp` here: the six landing-page screenshots (~310 KB total)
        // would otherwise land in every installed user's precache for a page most of them
        // never open offline. The cost is that an installed-PWA user who does open
        // About.html offline sees three broken images instead of none — accepted, not an
        // oversight.
        globPatterns: ["**/*.{js,wasm,css,html,ico,png,svg,woff2}"],
        // After the glyph-to-SVG sweep, nothing the app renders falls in the math or
        // symbols subsets' unicode-range, so the browser never requests these files —
        // online or offline. They still ship in dist (the @font-face rules reference
        // them) but stop costing ~37 KB in every user's precache.
        // Like globPatterns above, this array replaces the default, so it restates workbox's own node_modules exclusion.
        globIgnores: [
          "**/node_modules/**/*",
          "**/heebo-math-*",
          "**/heebo-symbols-*",
          // 1200x630 social card. Never requested by the app itself — only by scrapers,
          // which do not go through the service worker.
          "**/og.png",
          // about.html and privacy.html render from their own inline <style> with zero
          // JavaScript — no bundle, no fonts, no script. That's deliberate (they're the
          // pages Google's listing and consent screen point at), but it also means
          // neither page can ever run the app's update prompt (useAppUpdate), which is
          // the only thing that lets a `registerType: "prompt"` service worker take over.
          // A precached copy of either page can therefore go stale forever with no way
          // for the visitor to know. Exclude both so they're always fetched from the
          // network instead. See navigateFallbackDenylist below — without it, dropping
          // these from the precache alone would let every navigation to them fall
          // through to the app shell.
          "**/about.html",
          "**/privacy.html",
        ],
        // The NavigationRoute below has no allowlist of its own (matches `[/./]` by
        // default) and no denylist, so today it would win every navigation that isn't
        // served directly by precacheAndRoute — which is exactly how /about.html and
        // /privacy.html survive: precacheAndRoute registers its route first and wins.
        // Excluding those two pages from globIgnores above removes that protection, so
        // deny any navigation whose last path segment contains a dot. That's the same
        // invariant vercel.json's SPA rewrite already depends on (see
        // tests/app/spa-fallback.test.ts): no `<Route path="…">` in App.tsx contains a
        // dot, so this can only ever exclude a real static file — including any added
        // after this comment — never an app route. Workbox registers this NavigationRoute
        // before the runtimeCaching route below, so denying here is what lets that later
        // route actually get a turn — without it, this one would claim the navigation
        // first and the runtime cache would never run.
        navigateFallbackDenylist: [/^\/(?:[^/?]*\/)*[^/?]*\.[^/?]+(?:\?.*)?$/],
        // SettingsScreen.tsx and SetupStep.tsx link to these same two pages from inside
        // the installed, offline-first app shell. Excluding them from the precache (above)
        // fixed the staleness defect but broke that: offline, the browser now gets a
        // fetch failure instead of the stale-but-present page it used to serve. NetworkFirst
        // restores both properties at once — online, the network always wins so the page
        // stays fresh; offline, the last copy this runtime cache saw is served instead of
        // nothing. 3s timeout: the same value Workbox's own "offline copy of pages" recipe
        // uses — enough for a normal fetch, short enough that a genuinely offline visitor
        // isn't left waiting before the cached copy renders. No `expiration` plugin: two
        // small pages don't need cache-size or age limits, and it isn't otherwise needed
        // here (workbox-expiration ships with vite-plugin-pwa's workbox already, but
        // pulling it in for nothing would just be another moving part).
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname === "/about.html" || url.pathname === "/privacy.html",
            handler: "NetworkFirst",
            options: {
              cacheName: "static-pages",
              networkTimeoutSeconds: 3,
            },
          },
        ],
      },
    }),
  ],
});

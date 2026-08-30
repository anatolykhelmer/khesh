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
        theme_color: "#ffffff",
        background_color: "#f4f4f5",
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
        globPatterns: ["**/*.{js,wasm,css,html,ico,png,svg,woff2}"],
      },
    }),
  ],
});

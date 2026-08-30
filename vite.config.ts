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
        // The default glob is js,css,html,ico,png,svg — without woff2 the
        // self-hosted font is the one asset the service worker misses, and the
        // first offline launch silently falls back to the system font.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
      },
    }),
  ],
});

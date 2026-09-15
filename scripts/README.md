# scripts/

Tooling that builds the landing page's screenshots and share card. Nothing here ships in the
app bundle, and no file under `src/` imports it.

- `demo-book.ts` — a pure fixture built on the kernel: a household with a few months of
  realistic transactions, budgets and recurrences. No I/O.
- `cdp.ts` — a bare Chrome DevTools Protocol driver: spawns headless Chrome, connects to its
  debugging WebSocket, exposes `send()`/`poll()`. Chosen over Playwright specifically to add
  no new npm dependency for a script that runs a handful of times a year.
- `screenshots.ts` — the pipeline: build, `vite preview` on a fixed port, seed IndexedDB with
  the demo book over CDP, navigate each route in light and dark, capture WebP, then render
  the share card and capture it as PNG.
- `og-card.ts` — the share card's HTML, handed to Chrome via `Page.setDocumentContent` (no
  server needed for it).

## Running it

```bash
npm run screenshots
```

Needs Chrome at the default macOS path; set `CHROME=/path/to/chrome` to point at a different
binary or platform. Needs Node ≥ 22.15 (`module.registerHooks` and unflagged `.ts` execution
via `node-ts-extensions.mjs` — see `package.json`'s `engines`).

**Look at the output before committing it.** The script cannot tell a correctly-rendered
screenshot from a blank frame, an error banner, or the onboarding screen — open
`public/shots/*.webp` and `public/og.png` yourself.

The screenshots go stale silently: nothing re-runs this script or flags a diff when the UI
changes, so a redesigned screen can leave a months-old screenshot on the landing page
indefinitely. Re-run by hand whenever a screen it captures changes.

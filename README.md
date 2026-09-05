# Khesh

Offline-first household ledger using double-entry bookkeeping. Frontend-only (Vite + React); the working copy lives in IndexedDB on this device.

## Privacy

No accounts, no server, no telemetry. Data never leaves the browser unless you export it yourself from Settings, or you connect the optional sync to your own Google Drive - then the book is stored, unencrypted, in a `khesh-book.json` file in that Google account's Drive and nowhere else. There is still no server of ours and no telemetry.

## Disclaimer

This is an MVP, not accounting, tax, or investment advice. Books use `schemaVersion` 2; version 1 snapshots are migrated on load.

## Sync (optional)

Settings can connect the book to your own Google Drive (`drive.file` scope - the app
sees only the file it creates). Building with sync enabled needs a Google OAuth client
id in `VITE_GOOGLE_CLIENT_ID` (env var or `.env.local`); without it the Sync section
is hidden and the app stays fully offline.

## Quick start

```bash
npm install
npm test
npm run dev
```

## Languages

English and Hebrew (RTL). Language is chosen once on the onboarding screen.

## Kernel

Ledger logic lives in `src/kernel` as pure commands and queries on a `Book`. It must not import React, IndexedDB, or DOM APIs. It is not published to npm.

## See also

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [ROADMAP.md](ROADMAP.md)
- [LICENSE](LICENSE)

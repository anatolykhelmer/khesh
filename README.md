# Khesh

Offline-first household ledger using double-entry bookkeeping. Frontend-only (Vite + React); the working copy lives in IndexedDB on this device.

## Privacy

No accounts, no server, no telemetry. Data never leaves the browser unless you export it yourself from Settings.

## Disclaimer

This is an MVP, not accounting, tax, or investment advice. Books use `schemaVersion` 1; that schema may change in a later version without a migration tool.

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

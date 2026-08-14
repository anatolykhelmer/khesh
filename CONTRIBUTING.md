# Contributing

```bash
npm install
npm test
npm run dev
npm run build
```

`npm test` runs `tsc --noEmit` and then Vitest.

Kernel code (`src/kernel`) must not import React, IndexedDB, or DOM APIs.

One concern per pull request. Use English for issues and pull requests when a remote exists.

Design notes under `docs/superpowers/` and `docs/product/` are local maintainer files and are not in the repository.

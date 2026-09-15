# Security

Khesh stores the household book in the browser (IndexedDB). There is no authentication and no server of ours. The book leaves the browser only if you export it from Settings, or connect the optional Google Drive sync (`drive.file` scope) to a Google account — normally your own, or a family member's Drive if you have joined a book they shared with you.

JSON encode/decode backs the export/import UI in Settings and the Drive sync adapter. Exported files and the Drive copy (`khesh-book.json`) are both plain, unencrypted JSON.

## Reporting a vulnerability

Once the project is hosted on GitHub, use a private vulnerability advisory. Until then, do not file public issues about exploitable bugs.

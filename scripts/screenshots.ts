import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { launchChrome, poll, type Cdp } from "./cdp.ts";
import { buildDemoBook } from "./demo-book.ts";
import { ogCardHtml } from "./og-card.ts";
import { bookToJson } from "../src/adapters/json-codec.ts";

const PORT = 4399;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHOTS = "public/shots";
const SCREENS = [
  { route: "/dashboard", name: "dashboard" },
  { route: "/journal", name: "journal" },
  { route: "/budget", name: "budget" },
] as const;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}

async function waitForOrigin(): Promise<void> {
  await poll(
    () => fetch(ORIGIN).then((response) => (response.ok ? true : null)).catch(() => null),
    20_000,
    `nothing answered on ${ORIGIN} — is port ${PORT} taken by another session?`,
    200,
  );
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

/** The book loads asynchronously; capturing on `load` photographs an empty frame. */
async function waitForRender(cdp: Cdp): Promise<void> {
  await poll(
    async () => {
      const ready = await evaluate(
        cdp,
        `(document.querySelector(".app-shell")?.textContent ?? "").length > 50`,
      );
      return ready === true ? true : null;
    },
    15_000,
    "the app never rendered its shell",
    150,
  );
}

async function seed(cdp: Cdp): Promise<void> {
  const json = bookToJson(buildDemoBook(new Date().toISOString().slice(0, 10)));
  await evaluate(
    cdp,
    `(async () => {
      localStorage.setItem("khesh:lang", "en");
      const book = ${json};
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("khesh-ledger", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("books")) db.createObjectStore("books");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("books", "readwrite");
          tx.objectStore("books").put(book, "current");
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
    })()`,
  );
}

async function capture(cdp: Cdp, format: "webp" | "png"): Promise<Buffer> {
  const shot = await cdp.send("Page.captureScreenshot", {
    format,
    ...(format === "webp" ? { quality: 90 } : {}),
    captureBeyondViewport: false,
  });
  return Buffer.from(shot.data, "base64");
}

const FONT = "node_modules/@fontsource-variable/heebo/files/heebo-latin-wght-normal.woff2";

async function shootCard(cdp: Cdp): Promise<void> {
  const font = await readFile(FONT);
  const shot = await readFile(`${SHOTS}/dashboard-light.webp`);
  const html = ogCardHtml({
    fontDataUri: `data:font/woff2;base64,${font.toString("base64")}`,
    shotDataUri: `data:image/webp;base64,${shot.toString("base64")}`,
  });

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 630,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // The card is self-contained, so it needs no origin and no server — setDocumentContent
  // puts it straight into the frame.
  const { frameTree } = await cdp.send("Page.getFrameTree");
  await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  await evaluate(cdp, "document.fonts.ready.then(() => true)");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await writeFile("public/og.png", await capture(cdp, "png"));
  console.log("og.png");
}

async function main(): Promise<void> {
  await run("npm", ["run", "build"]);
  const preview = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { stdio: "inherit" },
  );
  try {
    await waitForOrigin();
    const chrome = await launchChrome();
    try {
      await shoot(chrome.cdp);
    } finally {
      // Nested, so a throw mid-capture still kills Chrome rather than leaving a
      // headless process and a temp profile behind.
      chrome.stop();
    }
  } finally {
    preview.kill();
  }
}

async function shoot(cdp: Cdp): Promise<void> {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await cdp.send("Page.navigate", { url: ORIGIN });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await seed(cdp);

  await mkdir(SHOTS, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    for (const screen of SCREENS) {
      await cdp.send("Page.navigate", { url: `${ORIGIN}${screen.route}` });
      await waitForRender(cdp);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(`${SHOTS}/${screen.name}-${theme}.webp`, await capture(cdp, "webp"));
      console.log(`${screen.name}-${theme}.webp`);
    }
  }

  await shootCard(cdp);
}

await main();

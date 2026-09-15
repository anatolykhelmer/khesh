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
    // Without this, a command that can't even be spawned (e.g. `npm` missing from PATH)
    // never fires 'exit' and the promise hangs forever instead of failing.
    child.on("error", (error) => reject(new Error(`could not start ${command}: ${error.message}`)));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}

// By the time this runs, main() has already confirmed nothing was answering on the port
// before this preview was spawned, so a timeout here isn't a taken port — it's this
// specific preview being slow to come up, or hung.
async function waitForOrigin(): Promise<void> {
  await poll(
    () => fetch(ORIGIN).then((response) => (response.ok ? true : null)).catch(() => null),
    20_000,
    `nothing answered on ${ORIGIN} within the timeout — vite preview may be slow to start, or hung`,
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
      // "khesh-ledger" v1, store "books", key "current" — this restates the contract that
      // src/adapters/indexeddb-repository.ts owns; nothing pins the two together, so if
      // that file's contract ever changes, this seed silently starts writing to a store
      // the app no longer reads from.
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

async function shootCard(cdp: Cdp, font: Buffer): Promise<void> {
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
  // Read before the build and the six captures, not after: this path reaches into a
  // dependency's internals (node_modules/@fontsource-variable/heebo/files/…), and a
  // restructure under the package's ^5.3.0 range should fail in the first second, not
  // after all the expensive work.
  const font = await readFile(FONT);
  await run("npm", ["run", "build"]);

  // A pre-existing occupant on the port answers a fetch faster than a brand-new `npx vite
  // preview` child can even finish starting up — so racing waitForOrigin against that
  // child's death (below) is not enough on its own: for a foreign or stale server that is
  // already up and responsive, waitForOrigin wins the race almost every time, and this
  // would go on to seed and photograph whatever is already there. Check for an occupant
  // before spawning anything of our own, while "nothing of ours is listening yet" is still
  // a fact we can rely on.
  const alreadyAnswering = await fetch(ORIGIN).then(
    () => true,
    () => false,
  );
  if (alreadyAnswering) {
    throw new Error(`something is already answering on ${ORIGIN} — is port ${PORT} taken by another session?`);
  }

  // Spawned as the vite binary directly, not via `npx vite` — npx wraps it in an extra
  // process, and a signal sent to that wrapper is not guaranteed to reach the real vite
  // child underneath it, which would then keep holding the port after this run believes
  // it cleaned up. Removing the wrapper removes that problem instead of managing it.
  const preview = spawn(
    "node_modules/.bin/vite",
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { stdio: "inherit" },
  );
  try {
    // The pre-flight check above closes the common case; this closes the narrow window
    // between it and vite's own bind attempt (or a genuine startup failure unrelated to the
    // port) by racing the wait against the child's death, so either still fails loudly
    // instead of photographing someone else's app.
    const died = new Promise<never>((_, reject) => {
      preview.on("exit", (code) =>
        reject(new Error(`vite preview exited ${code} — is port ${PORT} already taken?`)),
      );
    });
    await Promise.race([waitForOrigin(), died]);
    const chrome = await launchChrome();
    try {
      await shoot(chrome.cdp, font);
    } finally {
      // Nested, so a throw mid-capture still kills Chrome rather than leaving a
      // headless process and a temp profile behind.
      chrome.stop();
    }
  } finally {
    preview.kill();
  }
}

async function shoot(cdp: Cdp, font: Buffer): Promise<void> {
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

  await shootCard(cdp, font);
}

await main();

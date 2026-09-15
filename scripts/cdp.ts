import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Cdp = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
};

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// `message` is the whole string to throw on timeout — not a fragment poll composes into a
// generic sentence — so a caller with its own wording (e.g. one that names a port) gets it
// verbatim, with nothing downstream needing to pattern-match poll's phrasing back out.
// Likewise `attempt()` is awaited directly: a rejection there propagates out of poll
// unwrapped, exactly as it would from a hand-rolled loop, so a caller's own failures are
// never mistaken for — or mislabeled as — a timeout.
// intervalMs defaults to this function's original sleep — callers with their own cadence
// (screenshots.ts has two) pass it explicitly so reusing this loop changes no timing.
export async function poll<T>(
  attempt: () => Promise<T | null>,
  ms: number,
  message: string,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void }>();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id !== "number") return;
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    if (message.error) slot.reject(new Error(`${slot.method}: ${message.error.message}`));
    else slot.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

export async function launchChrome(): Promise<{ cdp: Cdp; stop: () => void }> {
  const profile = await mkdtemp(join(tmpdir(), "khesh-shots-"));
  // Port 0 makes Chrome pick a free one and write it to DevToolsActivePort. A fixed port
  // would collide with whatever a parallel session on this repository already has open.
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  // spawn's ENOENT (nothing at CHROME) arrives asynchronously on the child's 'error' event,
  // not as a throw, so the try/catch below never sees it on its own — the DevToolsActivePort
  // poll would just run its own 15s timeout and report a generic message with no mention of
  // CHROME. Race the poll against this so the real cause, and the fix, surface immediately.
  const failedToStart = new Promise<never>((_, reject) => {
    child.on("error", (error) =>
      reject(
        new Error(`could not start Chrome at "${CHROME}" (${error.message}) — set CHROME to override the path`),
      ),
    );
  });

  // Everything below can throw (the poll timeout, the fetch, "no page target", connect) —
  // wrap it so a failure here still kills the spawned Chrome instead of orphaning it, and
  // reraise unchanged so a caller debugging e.g. a timeout still sees the timeout.
  try {
    const port = await Promise.race([
      poll(
        async () => {
          const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
          const first = text.split("\n")[0];
          return /^\d+$/.test(first) ? Number(first) : null;
        },
        15_000,
        "timed out waiting for Chrome's debugging port",
      ),
      failedToStart,
    ]);

    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome exposed no page target");

    const cdp = await connect(page.webSocketDebuggerUrl);
    return {
      cdp,
      stop: () => {
        cdp.close();
        child.kill();
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

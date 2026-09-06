import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDriveSyncStore,
  createGoogleAuth,
  fetchAccountEmail,
} from "../../src/adapters/google-drive-sync";
import { ok } from "../../src/kernel/result";
import { unwrap, unwrapErr } from "../helpers";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  };
  return { impl, calls };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

type MultipartPart = { headers: string; body: string };

/** Splits an RFC 2046 multipart body into its parts, asserting the delimiter
 * structure as it goes: opening `--boundary`, `CRLF--boundary` between parts, and a
 * closing `CRLF--boundary--` followed by at most an empty epilogue. A `toContain`
 * on the body would pass against a body with no delimiters at all, and Google's
 * upload endpoint is the one wire format here that no local test can exercise for
 * real — so the shape gets parsed rather than sampled. */
function parseMultipart(body: string, boundary: string): MultipartPart[] {
  const opening = `--${boundary}\r\n`;
  const separator = `\r\n--${boundary}\r\n`;
  const closing = `\r\n--${boundary}--`;

  expect(body.startsWith(opening)).toBe(true);
  const closingAt = body.indexOf(closing);
  expect(closingAt).toBeGreaterThan(opening.length);
  expect(["", "\r\n"]).toContain(body.slice(closingAt + closing.length));

  return body
    .slice(opening.length, closingAt)
    .split(separator)
    .map((raw) => {
      const blankLine = raw.indexOf("\r\n\r\n");
      expect(blankLine).toBeGreaterThan(0);
      return { headers: raw.slice(0, blankLine), body: raw.slice(blankLine + 4) };
    });
}

function makeStore(handler: (call: Call) => Response | Promise<Response>, fileId: string | null = null) {
  const { impl, calls } = stubFetch(handler);
  const saved: string[] = [];
  const store = createDriveSyncStore({
    getToken: async () => ok("tok-1"),
    getFileId: () => fileId,
    onFileId: (id) => {
      saved.push(id);
    },
    fetchImpl: impl,
  });
  return { store, calls, saved };
}

describe("drive sync store", () => {
  it("probe with no file anywhere returns null after searching by name", async () => {
    const { store, calls } = makeStore(() => json({ files: [] }));
    expect(unwrap(await store.probe())).toBeNull();
    expect(calls[0].url).toContain("https://www.googleapis.com/drive/v3/files?");
    expect(decodeURIComponent(calls[0].url)).toContain("name='khesh-book.json'");
    expect(calls[0].headers.Authorization).toBe("Bearer tok-1");
  });

  it("probe with a known fileId asks for modifiedTime only", async () => {
    const { store, calls } = makeStore(() => json({ modifiedTime: "2026-09-02T09:00:00.000Z" }), "f9");
    expect(unwrap(await store.probe())).toEqual({ rev: "2026-09-02T09:00:00.000Z" });
    expect(calls[0].url).toContain("/files/f9?");
    expect(calls[0].url).toContain("fields=modifiedTime");
  });

  it("read fetches metadata then media", async () => {
    const { store, calls } = makeStore(
      (call) =>
        call.url.includes("alt=media")
          ? new Response('{"app":"khesh"}', { status: 200 })
          : json({ modifiedTime: "rev-2" }),
      "f9",
    );
    expect(unwrap(await store.read())).toEqual({ payload: '{"app":"khesh"}', rev: "rev-2" });
    expect(calls).toHaveLength(2);
  });

  it("write without a fileId searches, then creates via multipart and reports the new id", async () => {
    const { store, calls, saved } = makeStore((call) => {
      if (call.method === "GET") return json({ files: [] });
      return json({ id: "created-1", modifiedTime: "rev-1" });
    });
    expect(unwrap(await store.write("PAYLOAD"))).toEqual({ rev: "rev-1" });
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.url).toContain("https://www.googleapis.com/upload/drive/v3/files?");
    expect(create.url).toContain("uploadType=multipart");

    const contentType = create.headers["Content-Type"];
    expect(contentType).toMatch(/^multipart\/related; boundary=.+$/);
    const boundary = contentType.slice("multipart/related; boundary=".length);

    const parts = parseMultipart(create.body ?? "", boundary);
    expect(parts).toHaveLength(2);
    expect(parts[0].headers).toBe("Content-Type: application/json; charset=UTF-8");
    expect(JSON.parse(parts[0].body)).toEqual({ name: "khesh-book.json" });
    expect(parts[1].headers).toBe("Content-Type: application/json");
    expect(parts[1].body).toBe("PAYLOAD");
    expect(saved).toEqual(["created-1"]);
  });

  it("write with a fileId PATCHes media", async () => {
    const { store, calls } = makeStore(() => json({ id: "f9", modifiedTime: "rev-3" }), "f9");
    expect(unwrap(await store.write("PAYLOAD"))).toEqual({ rev: "rev-3" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("https://www.googleapis.com/upload/drive/v3/files/f9?uploadType=media");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body).toBe("PAYLOAD");
  });

  it("refuses to guess when the name search returns two files, and creates nothing", async () => {
    // Two devices connecting for the first time at once can each create their own
    // khesh-book.json. Picking the first would cache a different id on each and fork the
    // book permanently, so every entry point refuses instead — and `write` in particular
    // must not fall through to the create branch.
    const search = () => json({ files: [{ id: "dup-a" }, { id: "dup-b" }] });

    const probe = makeStore(search);
    const probeError = unwrapErr(await probe.store.probe());
    expect(probeError.code).toBe("SYNC_FILE_AMBIGUOUS");
    expect(probeError.details).toEqual({ fileIds: ["dup-a", "dup-b"] });
    expect(probe.calls).toHaveLength(1); // the search, and nothing after it
    expect(probe.saved).toEqual([]);

    const read = makeStore(search);
    expect(unwrapErr(await read.store.read()).code).toBe("SYNC_FILE_AMBIGUOUS");
    expect(read.calls).toHaveLength(1);

    const write = makeStore(search);
    expect(unwrapErr(await write.store.write("PAYLOAD")).code).toBe("SYNC_FILE_AMBIGUOUS");
    expect(write.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(write.saved).toEqual([]);
  });

  it("still resolves a single search hit and caches its id", async () => {
    const { store, calls, saved } = makeStore((call) =>
      call.url.includes("?q=") ? json({ files: [{ id: "only-1" }] }) : json({ modifiedTime: "rev-7" }),
    );
    expect(unwrap(await store.probe())).toEqual({ rev: "rev-7" });
    expect(saved).toEqual(["only-1"]);
    expect(calls[1].url).toContain("/files/only-1?");
  });

  it("guards the PATCH with the ETag Drive returned for the rev the caller merged against", async () => {
    const { store, calls } = makeStore((call) => {
      if (call.url.includes("alt=media")) {
        return new Response("{}", { status: 200, headers: { ETag: '"etag-7"' } });
      }
      if (call.method === "PATCH") return json({ id: "f9", modifiedTime: "rev-8" });
      return json({ modifiedTime: "rev-7" });
    }, "f9");

    const read = unwrap(await store.read())!;
    expect(unwrap(await store.write("PAYLOAD", read.rev))).toEqual({ rev: "rev-8" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.headers["If-Match"]).toBe('"etag-7"');
  });

  it("sends no precondition unconditionally, nor for a rev it holds no validator for", async () => {
    const handler = (call: Call) => {
      if (call.url.includes("alt=media")) {
        return new Response("{}", { status: 200, headers: { ETag: '"etag-7"' } });
      }
      if (call.method === "PATCH") return json({ id: "f9", modifiedTime: "rev-8" });
      return json({ modifiedTime: "rev-7" });
    };

    // The explicit overwrite actions (resolveUseLocal, replaceRemote) pass no rev.
    const plain = makeStore(handler, "f9");
    await plain.store.read();
    await plain.store.write("PAYLOAD");
    expect(plain.calls.find((c) => c.method === "PATCH")!.headers["If-Match"]).toBeUndefined();

    // ...and a rev this store never read is not a validator it may invent one for.
    const stale = makeStore(handler, "f9");
    await stale.store.read();
    await stale.store.write("PAYLOAD", "rev-1");
    expect(stale.calls.find((c) => c.method === "PATCH")!.headers["If-Match"]).toBeUndefined();

    // Drive v3 documents no precondition for files.update, so it may simply send no
    // ETag. Then the write stays exactly the unconditional PATCH it has always been.
    const noEtag = makeStore(
      (call) =>
        call.url.includes("alt=media")
          ? new Response("{}", { status: 200 })
          : call.method === "PATCH"
            ? json({ id: "f9", modifiedTime: "rev-8" })
            : json({ modifiedTime: "rev-7" }),
      "f9",
    );
    const read = unwrap(await noEtag.store.read())!;
    expect(unwrap(await noEtag.store.write("PAYLOAD", read.rev))).toEqual({ rev: "rev-8" });
    expect(noEtag.calls.find((c) => c.method === "PATCH")!.headers["If-Match"]).toBeUndefined();
  });

  it("retires the guard and retries once when Drive rejects the header itself", async () => {
    // If-Match is undocumented for files.update, so Drive may reject it rather than
    // ignore it. Without this fallback every guarded write would fail forever, reported
    // as SYNC_STORE_FAILED -- a network problem the user cannot act on, from a network
    // that is fine.
    const { store, calls } = makeStore((call) => {
      if (call.url.includes("alt=media")) {
        return new Response("{}", { status: 200, headers: { ETag: '"etag-7"' } });
      }
      if (call.method === "PATCH") {
        return call.headers["If-Match"] !== undefined
          ? json({ error: "unsupported header" }, 400)
          : json({ id: "f9", modifiedTime: "rev-8" });
      }
      return json({ modifiedTime: "rev-7" });
    }, "f9");

    const read = unwrap(await store.read())!;
    expect(unwrap(await store.write("PAYLOAD", read.rev))).toEqual({ rev: "rev-8" });

    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2); // exactly one retry, not a loop
    expect(patches[0].headers["If-Match"]).toBe('"etag-7"');
    expect(patches[1].headers["If-Match"]).toBeUndefined();
    expect(patches[1].body).toBe("PAYLOAD");
  });

  it("does not retry an unguarded write, nor a guarded one that never got an answer", async () => {
    // The retry exists for a status Drive answered with. A plain write has no guard to
    // retire, and a transport failure would only spend the timeout a second time.
    const plain = makeStore(() => json({}, 400), "f9");
    expect(unwrapErr(await plain.store.write("PAYLOAD")).code).toBe("SYNC_STORE_FAILED");
    expect(plain.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    let patches = 0;
    const dead = makeStore((call) => {
      if (call.url.includes("alt=media")) {
        return new Response("{}", { status: 200, headers: { ETag: '"etag-7"' } });
      }
      if (call.method === "PATCH") {
        patches += 1;
        throw new TypeError("offline");
      }
      return json({ modifiedTime: "rev-7" });
    }, "f9");
    const read = unwrap(await dead.store.read())!;
    expect(unwrapErr(await dead.store.write("PAYLOAD", read.rev)).code).toBe("SYNC_STORE_FAILED");
    expect(patches).toBe(1);
  });

  it("maps 412 to SYNC_REMOTE_CHANGED, distinctly from a generic store failure", async () => {
    const { store } = makeStore((call) => {
      if (call.url.includes("alt=media")) {
        return new Response("{}", { status: 200, headers: { ETag: '"etag-7"' } });
      }
      if (call.method === "PATCH") return json({}, 412);
      return json({ modifiedTime: "rev-7" });
    }, "f9");
    const read = unwrap(await store.read())!;
    // Not SYNC_STORE_FAILED: the device is online, and the engine's answer to this is to
    // re-run the cycle now rather than to sit in `offline` waiting for a network.
    expect(unwrapErr(await store.write("PAYLOAD", read.rev)).code).toBe("SYNC_REMOTE_CHANGED");

    const other = makeStore(() => json({}, 500), "f9");
    expect(unwrapErr(await other.store.write("PAYLOAD")).code).toBe("SYNC_STORE_FAILED");
  });

  it("maps 401 to SYNC_AUTH_REQUIRED, 404 to SYNC_FILE_MISSING, thrown fetch to SYNC_STORE_FAILED", async () => {
    const auth = makeStore(() => json({}, 401), "f9");
    expect(unwrapErr(await auth.store.probe()).code).toBe("SYNC_AUTH_REQUIRED");
    const missing = makeStore(() => json({}, 404), "f9");
    expect(unwrapErr(await missing.store.probe()).code).toBe("SYNC_FILE_MISSING");
    const network = makeStore(() => {
      throw new TypeError("offline");
    }, "f9");
    expect(unwrapErr(await network.store.probe()).code).toBe("SYNC_STORE_FAILED");
  });

  it("fetchAccountEmail reads drive/v3/about", async () => {
    const { impl, calls } = stubFetch(() => json({ user: { emailAddress: "a@b.c" } }));
    expect(unwrap(await fetchAccountEmail(async () => ok("tok"), impl))).toBe("a@b.c");
    expect(calls[0].url).toContain("/drive/v3/about?fields=user");
  });
});

type Prompt = { prompt?: "" | "consent" } | undefined;

/**
 * The `window.google` object GIS installs, reduced to what this module actually calls.
 * With it present `loadGisScript` returns early, so nothing here touches `document` —
 * which is what lets the coalescing logic be tested in the node environment the rest of
 * the suite runs in. The token flow's *browser* half (script injection, popups) is still
 * out of reach and still untested.
 */
function fakeGis() {
  const requests: Prompt[] = [];
  let callback: (response: { access_token?: string; expires_in?: number; error?: string }) => void =
    () => undefined;
  let clients = 0;
  (globalThis as { google?: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient(config: { callback: typeof callback }) {
          clients += 1;
          callback = config.callback;
          return {
            requestAccessToken(options?: Prompt) {
              requests.push(options);
            },
          };
        },
        revoke: (_token: string, done?: () => void) => done?.(),
      },
    },
  };
  return {
    requests,
    clients: () => clients,
    grant: (accessToken: string) => callback({ access_token: accessToken, expires_in: 3600 }),
    deny: () => callback({ error: "popup" }),
  };
}

describe("google auth token requests", () => {
  afterEach(() => {
    delete (globalThis as { google?: unknown }).google;
    vi.useRealTimers();
  });

  it("a second cold caller shares the first request instead of orphaning it", async () => {
    const gis = fakeGis();
    const auth = createGoogleAuth("client-1");

    const first = auth.getToken(false);
    const second = auth.getToken(false);
    await Promise.resolve(); // let both reach the (already loaded) GIS client
    expect(gis.requests).toHaveLength(1); // one flow, not two

    gis.grant("tok-9");
    // Both settle on that one response. Before coalescing, `second` overwrote the
    // pending slot and `first` sat until its 15s timeout, whatever the flow returned.
    expect(unwrap(await first)).toBe("tok-9");
    expect(unwrap(await second)).toBe("tok-9");
  });

  it("does not leave the orphaned caller waiting on the 15s timeout", async () => {
    vi.useFakeTimers();
    const gis = fakeGis();
    const auth = createGoogleAuth("client-1");
    const settled: string[] = [];
    const first = auth.getToken(false).then((r) => settled.push(r.ok ? "ok" : r.error.code));
    const second = auth.getToken(false).then((r) => settled.push(r.ok ? "ok" : r.error.code));

    await Promise.resolve();
    gis.grant("tok-9");
    await Promise.all([first, second]);

    expect(settled).toEqual(["ok", "ok"]); // both, with no timer ever advanced
    await vi.advanceTimersByTimeAsync(20_000); // and the shared timer was cleared
    expect(settled).toEqual(["ok", "ok"]);
  });

  it("keeps the cached token fast path: a later call starts no new flow", async () => {
    const gis = fakeGis();
    const auth = createGoogleAuth("client-1");
    const first = auth.getToken(false);
    await Promise.resolve();
    gis.grant("tok-9");
    await first;

    expect(unwrap(await auth.getToken(false))).toBe("tok-9");
    expect(gis.requests).toHaveLength(1);
  });

  it("a tap waits out a silent request rather than settling for its answer", async () => {
    const gis = fakeGis();
    const auth = createGoogleAuth("client-1");

    const silent = auth.getToken(false);
    await Promise.resolve();
    const tap = auth.getToken(true);
    await Promise.resolve();
    expect(gis.requests).toEqual([{ prompt: "" }]); // the tap did not clobber the slot

    gis.deny(); // the silent path fails, as it does with no active Google session
    expect(unwrapErr(await silent).code).toBe("SYNC_AUTH_REQUIRED");
    await Promise.resolve();
    expect(gis.requests).toEqual([{ prompt: "" }, undefined]); // ...then the tap asks

    gis.grant("tok-tap");
    expect(unwrap(await tap)).toBe("tok-tap");
    expect(gis.clients()).toBe(1); // one token client for the lifetime of the auth
  });
});

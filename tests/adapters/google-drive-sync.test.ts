import { createDriveSyncStore, fetchAccountEmail } from "../../src/adapters/google-drive-sync";
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
    expect(create.url).toContain("uploadType=multipart");
    expect(create.body).toContain('"name":"khesh-book.json"');
    expect(create.body).toContain("PAYLOAD");
    expect(saved).toEqual(["created-1"]);
  });

  it("write with a fileId PATCHes media", async () => {
    const { store, calls } = makeStore(() => json({ id: "f9", modifiedTime: "rev-3" }), "f9");
    expect(unwrap(await store.write("PAYLOAD"))).toEqual({ rev: "rev-3" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/files/f9?uploadType=media");
    expect(calls[0].body).toBe("PAYLOAD");
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

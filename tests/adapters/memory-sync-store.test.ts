import { createMemorySyncStore } from "../../src/adapters/memory-sync-store";
import { unwrap, unwrapErr } from "../helpers";

describe("memory sync store", () => {
  it("starts empty: probe and read return null", async () => {
    const store = createMemorySyncStore();
    expect(unwrap(await store.probe())).toBeNull();
    expect(unwrap(await store.read())).toBeNull();
  });

  it("write stores the payload and bumps rev", async () => {
    const store = createMemorySyncStore();
    const first = unwrap(await store.write("one"));
    const second = unwrap(await store.write("two"));
    expect(first.rev).not.toBe(second.rev);
    expect(unwrap(await store.read())).toEqual({ payload: "two", rev: second.rev });
    expect(unwrap(await store.probe())).toEqual({ rev: second.rev });
  });

  it("setPayload simulates an external writer", async () => {
    const store = createMemorySyncStore("seed");
    const before = unwrap(await store.probe())!.rev;
    store.setPayload("other-device");
    const after = unwrap(await store.probe())!.rev;
    expect(after).not.toBe(before);
    expect(unwrap(await store.read())!.payload).toBe("other-device");
  });

  it("failNext fails exactly one call", async () => {
    const store = createMemorySyncStore("seed");
    store.failNext("SYNC_AUTH_REQUIRED");
    expect(unwrapErr(await store.read()).code).toBe("SYNC_AUTH_REQUIRED");
    expect(unwrap(await store.read())!.payload).toBe("seed");
  });
});

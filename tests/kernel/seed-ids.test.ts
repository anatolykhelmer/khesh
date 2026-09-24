import { describe, expect, it } from "vitest";
import { isSeedAccountId, seedAccountId } from "../../src/kernel/seed-ids";

describe("seedAccountId", () => {
  it("gives a group its key alone, because a group cannot hold money", () => {
    expect(seedAccountId({ key: "assets", isPlaceholder: true, currency: "ILS" })).toBe("seed:assets");
    expect(seedAccountId({ key: "housing", isPlaceholder: true, currency: "USD" })).toBe("seed:housing");
  });

  it("gives a leaf its currency too, so two home currencies stay two accounts", () => {
    expect(seedAccountId({ key: "cash", isPlaceholder: false, currency: "ILS" })).toBe("seed:cash:ILS");
    expect(seedAccountId({ key: "cash", isPlaceholder: false, currency: "USD" })).toBe("seed:cash:USD");
  });

  it("is a pure function of the fields, so two devices with one answer set agree", () => {
    const item = { key: "groceries", isPlaceholder: false, currency: "ILS" };
    expect(seedAccountId(item)).toBe(seedAccountId({ ...item }));
  });
});

describe("isSeedAccountId", () => {
  it("recognises its own ids and nothing else", () => {
    expect(isSeedAccountId("seed:assets")).toBe(true);
    expect(isSeedAccountId("seed:cash:ILS")).toBe(true);
    expect(isSeedAccountId("01J9ZQ7X8P0000000000000000")).toBe(false);
    expect(isSeedAccountId("sys:ob")).toBe(false);
    expect(isSeedAccountId("root:expense")).toBe(false);
  });
});

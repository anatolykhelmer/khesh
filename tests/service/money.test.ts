import { describe, expect, it } from "vitest";
import { majorToMinor, minorToMajor } from "../../src/service/money";

describe("money", () => {
  it("converts major string to minor units", () => {
    expect(majorToMinor("12.34")).toBe(1234);
    expect(majorToMinor("12")).toBe(1200);
    expect(majorToMinor("0.01")).toBe(1);
  });

  it("rejects invalid major strings", () => {
    expect(majorToMinor("")).toBeNull();
    expect(majorToMinor("abc")).toBeNull();
    expect(majorToMinor("12.345")).toBeNull();
    expect(majorToMinor("-1")).toBeNull();
  });

  it("formats minor units as major string", () => {
    expect(minorToMajor(1234)).toBe("12.34");
    expect(minorToMajor(100)).toBe("1.00");
    expect(minorToMajor(0)).toBe("0.00");
  });
});

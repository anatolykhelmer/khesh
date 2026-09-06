import { canonicalJson } from "../../src/kernel/canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });

  it("is insensitive to key insertion order", () => {
    const x: Record<string, unknown> = {};
    x.z = 1;
    x.a = 2;
    const y: Record<string, unknown> = {};
    y.a = 2;
    y.z = 1;
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it("omits undefined members and handles primitives", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson("s")).toBe('"s"');
    expect(canonicalJson(5)).toBe("5");
  });
});

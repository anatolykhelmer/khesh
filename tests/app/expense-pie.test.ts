import { describe, expect, it } from "vitest";
import { pieArcs } from "../../src/app/expense-pie";

const OPTS = { cx: 100, cy: 100, r: 90 };

describe("pieArcs", () => {
  it("returns nothing for an empty list or a zero total", () => {
    expect(pieArcs([], OPTS)).toEqual([]);
    expect(pieArcs([{ id: "a", amount: 0 }], OPTS)).toEqual([]);
  });

  it("draws a full circle as two 180 degree arcs for a single slice", () => {
    const arcs = pieArcs([{ id: "rent", amount: 100 }], OPTS);
    expect(arcs).toHaveLength(1);
    expect(arcs[0].id).toBe("rent");
    expect(arcs[0].d).toBe(
      "M 100 100 L 100 10 A 90 90 0 0 1 100 190 A 90 90 0 0 1 100 10 Z",
    );
  });

  it("splits two equal slices at 6 o'clock", () => {
    const arcs = pieArcs(
      [
        { id: "a", amount: 50 },
        { id: "b", amount: 50 },
      ],
      OPTS,
    );
    expect(arcs.map((a) => a.id)).toEqual(["a", "b"]);
    expect(arcs[0].d).toBe("M 100 100 L 100 10 A 90 90 0 0 1 100 190 Z");
    expect(arcs[1].d).toBe("M 100 100 L 100 190 A 90 90 0 0 1 100 10 Z");
  });

  it("preserves input order for three slices", () => {
    const arcs = pieArcs(
      [
        { id: "a", amount: 50 },
        { id: "b", amount: 30 },
        { id: "c", amount: 20 },
      ],
      OPTS,
    );
    expect(arcs.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(arcs).toHaveLength(3);
    for (const arc of arcs) {
      expect(arc.d.startsWith("M ")).toBe(true);
      expect(arc.d.endsWith(" Z")).toBe(true);
      expect(arc.d.includes(" A ")).toBe(true);
    }
  });
});

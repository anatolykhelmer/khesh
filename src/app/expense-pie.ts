export type PieArc = {
  id: string;
  d: string;
};

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function point(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: round(cx + r * Math.cos(rad)), y: round(cy + r * Math.sin(rad)) };
}

function wedge(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const start = point(cx, cy, r, startDeg);
  const end = point(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y} Z`;
}

export function pieArcs(
  slices: ReadonlyArray<{ id: string; amount: number }>,
  opts: { cx: number; cy: number; r: number },
): PieArc[] {
  const total = slices.reduce((sum, slice) => sum + slice.amount, 0);
  if (total <= 0) return [];
  const { cx, cy, r } = opts;
  if (slices.length === 1) {
    const mid = point(cx, cy, r, 180);
    const start = point(cx, cy, r, 0);
    return [
      {
        id: slices[0].id,
        d: `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 0 1 ${mid.x} ${mid.y} A ${r} ${r} 0 0 1 ${start.x} ${start.y} Z`,
      },
    ];
  }
  const arcs: PieArc[] = [];
  let startDeg = 0;
  for (const slice of slices) {
    const sweep = (slice.amount / total) * 360;
    const endDeg = startDeg + sweep;
    arcs.push({ id: slice.id, d: wedge(cx, cy, r, startDeg, endDeg) });
    startDeg = endDeg;
  }
  return arcs;
}

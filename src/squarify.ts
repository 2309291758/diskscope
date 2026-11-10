import type { NodeView } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  node: NodeView;
}

/** Squarified treemap (Bruls, Huizing, van Wijk 2000). */
export function squarify(items: NodeView[], x: number, y: number, w: number, h: number): Rect[] {
  const out: Rect[] = [];
  const nodes = items.filter((n) => n.size > 0);
  if (!nodes.length || w <= 0 || h <= 0) return out;

  const total = nodes.reduce((s, n) => s + n.size, 0);
  if (total <= 0) return out;

  // Normalised areas so the algorithm is resolution independent.
  const areas = nodes.map((n) => (n.size / total) * w * h);
  let cx = x;
  let cy = y;
  let cw = w;
  let ch = h;
  let i = 0;

  while (i < nodes.length) {
    const shortSide = Math.min(cw, ch);
    let rowEnd = i + 1;
    let rowArea = areas[i];
    let bestRatio = worstRatio(areas.slice(i, rowEnd), rowArea, shortSide);

    while (rowEnd < nodes.length) {
      const nextArea = rowArea + areas[rowEnd];
      const ratio = worstRatio(areas.slice(i, rowEnd + 1), nextArea, shortSide);
      if (ratio > bestRatio) break;
      bestRatio = ratio;
      rowArea = nextArea;
      rowEnd++;
    }

    const count = rowEnd - i;
    if (cw >= ch) {
      const colW = rowArea / ch;
      let oy = cy;
      for (let k = i; k < rowEnd; k++) {
        const rh = (areas[k] / rowArea) * ch;
        out.push({ x: cx, y: oy, w: colW, h: rh, node: nodes[k] });
        oy += rh;
      }
      cx += colW;
      cw -= colW;
    } else {
      const rowH = rowArea / cw;
      let ox = cx;
      for (let k = i; k < rowEnd; k++) {
        const rw = (areas[k] / rowArea) * cw;
        out.push({ x: ox, y: cy, w: rw, h: rowH, node: nodes[k] });
        ox += rw;
      }
      cy += rowH;
      ch -= rowH;
    }
    i = rowEnd;
    if (count <= 0) break;
  }
  return out;
}

function worstRatio(rowAreas: number[], rowArea: number, shortSide: number): number {
  if (rowArea <= 0 || shortSide <= 0) return Infinity;
  const thick = rowArea / shortSide;
  if (thick <= 0) return Infinity;
  let worst = 1;
  for (const a of rowAreas) {
    if (a <= 0) continue;
    const len = a / thick;
    if (len <= 0) continue;
    const ratio = Math.max(thick / len, len / thick);
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

import type { Pt } from "./geo";

export type { Pt };
export type ZoneKind = "rect" | "circle" | "poly";

const CIRCLE_SEGMENTS = 48;
const MAX_LINES = 300;

/**
 * Convierte los puntos marcados en un polígono.
 * rect: dos esquinas opuestas · circle: centro y un punto del borde · poly: vértices.
 */
export function shapePolygon(kind: ZoneKind, pts: Pt[]): Pt[] {
  if (kind === "rect") {
    if (pts.length < 2) return [];
    const [a, b] = pts;
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  }
  if (kind === "circle") {
    if (pts.length < 2) return [];
    const [c, e] = pts;
    const r = Math.hypot(e.x - c.x, e.y - c.y);
    return Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
    });
  }
  return pts;
}

/** Área en m² (fórmula del cordón). */
export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function pathLength(path: Pt[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return d;
}

/**
 * Ruta de barrido en zigzag (pasadas este-oeste) que cubre el polígono,
 * con `spacing` metros entre pasadas.
 */
export function coveragePath(poly: Pt[], spacing: number): Pt[] {
  if (poly.length < 3) return [];
  const minY = Math.min(...poly.map((p) => p.y));
  const maxY = Math.max(...poly.map((p) => p.y));
  const step = Math.max(spacing, (maxY - minY) / MAX_LINES);
  const ys: number[] = [];
  for (let y = minY + step / 2; y < maxY; y += step) ys.push(y);
  if (ys.length === 0) ys.push((minY + maxY) / 2);

  const path: Pt[] = [];
  let leftToRight = true;
  for (const y of ys) {
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    if (!leftToRight) xs.reverse();
    // en polígonos cóncavos una pasada puede tener varios tramos
    for (let i = 0; i + 1 < xs.length; i += 2) path.push({ x: xs[i], y }, { x: xs[i + 1], y });
    leftToRight = !leftToRight;
  }
  return path;
}

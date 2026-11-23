"use client";

import { useState, type PointerEvent } from "react";

type Props = {
  label: string;
  unit: string;
  values: number[];
  /** Segundos entre muestras, para el texto "hace N s" al pasar el cursor. */
  interval: number;
  format: (v: number) => string;
};

const W = 100;
const H = 30;

export default function Sparkline({ label, unit, values, interval, format }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const idx = hover !== null && hover < n ? hover : n - 1;
  const shown = n > 0 ? values[idx] : null;

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  let min = lo;
  let max = hi;
  if (!(max - min > 1e-9)) {
    min -= 1;
    max += 1;
  }
  const px = (i: number) => (n > 1 ? (i / (n - 1)) * W : W);
  const py = (v: number) => H - 2 - ((v - min) / (max - min)) * (H - 4);
  const path = values.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(2)},${py(v).toFixed(2)}`).join("");

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (n < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.round(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * (n - 1)));
  };

  return (
    <div className="spark">
      <div className="spark-head">
        <span className="spark-label">{label}</span>
        <span className="spark-value">
          {shown === null ? "—" : format(shown)} <small>{unit}</small>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${label}: ${shown === null ? "sin datos" : `${format(shown)} ${unit}`}`}
      >
        {n > 1 && <path d={path} className="spark-line" vectorEffect="non-scaling-stroke" />}
        {hover !== null && n > 1 && (
          <line x1={px(idx)} x2={px(idx)} y1={0} y2={H} className="spark-cross" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="spark-foot">
        {hover !== null && n > 1
          ? `hace ${((n - 1 - idx) * interval).toFixed(0)} s`
          : n > 1
            ? `últimos ${((n - 1) * interval).toFixed(0)} s · ${format(lo)} – ${format(hi)}`
            : "esperando datos"}
      </div>
    </div>
  );
}

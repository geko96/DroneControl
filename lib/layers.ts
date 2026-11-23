export type LayerKey = "temperature" | "soilMoisture" | "soilTemp" | "humidity" | "elevation";

export type Layer = {
  key: LayerKey;
  label: string;
  unit: string;
  /** Rampa secuencial de un solo tono, de valor bajo (oscuro) a alto (claro). */
  ramp: [string, string, string];
  format: (v: number) => string;
};

export const LAYERS: Layer[] = [
  { key: "temperature", label: "Temperatura", unit: "°C", ramp: ["#3b1206", "#c2410c", "#fed7aa"], format: (v) => v.toFixed(1) },
  { key: "soilMoisture", label: "Humedad del suelo", unit: "m³/m³", ramp: ["#0c2a4d", "#2563eb", "#bfdbfe"], format: (v) => v.toFixed(3) },
  { key: "soilTemp", label: "Temp. del suelo", unit: "°C", ramp: ["#3f0d1c", "#be123c", "#fecdd3"], format: (v) => v.toFixed(1) },
  { key: "humidity", label: "Humedad del aire", unit: "%", ramp: ["#06302e", "#0d9488", "#99f6e4"], format: (v) => v.toFixed(0) },
  { key: "elevation", label: "Altura", unit: "m s. n. m.", ramp: ["#2a2622", "#8a7a66", "#f1e7d6"], format: (v) => v.toFixed(0) },
];

export const layerByKey = (key: LayerKey) => LAYERS.find((l) => l.key === key)!;

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Color CSS de la rampa para t en [0,1]. */
export function rampCss(ramp: string[], t: number): string {
  const x = Math.min(Math.max(t, 0), 1) * (ramp.length - 1);
  const i = Math.min(Math.floor(x), ramp.length - 2);
  const a = hex(ramp[i]);
  const b = hex(ramp[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * (x - i)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

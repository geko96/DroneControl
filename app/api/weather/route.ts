import { NextRequest, NextResponse } from "next/server";
import "../../../lib/serverNet";

const API = "https://api.open-meteo.com/v1/forecast";
const VARS =
  "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,soil_moisture_0_to_1cm,soil_temperature_0cm";
const MAX_POINTS = 50;
const CACHE_MS = 15 * 60_000;

type Node = {
  temperature: number;
  humidity: number;
  soilMoisture: number;
  soilTemp: number;
  windSpeed: number;
  windDir: number;
  elevation: number;
};

// Caché en memoria por coordenada: los nodos de la retícula se repiten entre pedidos.
const cache = new Map<string, { at: number; node: Node }>();

/** Clima y suelo actuales (modelo Open-Meteo) para una lista de puntos: ?lat=a,b&lon=c,d */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const lats = (q.get("lat") ?? "").split(",").map(Number);
  const lons = (q.get("lon") ?? "").split(",").map(Number);
  if (
    lats.length === 0 || lats.length !== lons.length || lats.length > MAX_POINTS ||
    lats.some((v) => !Number.isFinite(v) || Math.abs(v) > 90) ||
    lons.some((v) => !Number.isFinite(v) || Math.abs(v) > 180)
  ) {
    return NextResponse.json({ error: "Parámetros inválidos" }, { status: 400 });
  }

  const keys = lats.map((lat, i) => `${lat},${lons[i]}`);
  const now = Date.now();
  const missing = keys.filter((k) => !((cache.get(k)?.at ?? 0) > now - CACHE_MS));

  if (missing.length > 0) {
    try {
      const la = missing.map((k) => k.split(",")[0]).join(",");
      const lo = missing.map((k) => k.split(",")[1]).join(",");
      const res = await fetch(`${API}?latitude=${la}&longitude=${lo}&current=${VARS}&wind_speed_unit=ms`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
      const json = await res.json();
      const list: { elevation: number; current: Record<string, number | null> }[] = Array.isArray(json) ? json : [json];
      if (list.length !== missing.length) throw new Error("Respuesta incompleta");
      // sobre agua no hay datos de suelo: se usa la media del lote (o 0)
      const mean = (name: string) => {
        const valid = list.map((p) => p.current[name]).filter((v): v is number => typeof v === "number");
        return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
      };
      const val = (p: (typeof list)[number], name: string) => p.current[name] ?? mean(name);
      list.forEach((p, i) => {
        cache.set(missing[i], {
          at: now,
          node: {
            temperature: val(p, "temperature_2m"),
            humidity: val(p, "relative_humidity_2m"),
            soilMoisture: val(p, "soil_moisture_0_to_1cm"),
            soilTemp: val(p, "soil_temperature_0cm"),
            windSpeed: val(p, "wind_speed_10m"),
            windDir: val(p, "wind_direction_10m"),
            elevation: p.elevation,
          },
        });
      });
    } catch (e) {
      console.warn("[weather]", e);
      return NextResponse.json({ error: "Clima no disponible" }, { status: 502 });
    }
  }
  return NextResponse.json(keys.map((k) => cache.get(k)!.node));
}

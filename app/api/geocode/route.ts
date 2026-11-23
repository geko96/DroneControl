import { NextRequest, NextResponse } from "next/server";
import "../../../lib/serverNet";

const API = "https://geocoding-api.open-meteo.com/v1/search";

type Hit = { name: string; latitude: number; longitude: number; admin1?: string; admin2?: string; population?: number };

/** Busca localidades de Argentina por nombre (geocodificador de Open-Meteo, base GeoNames). */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 80) return NextResponse.json([]);
  try {
    const res = await fetch(`${API}?name=${encodeURIComponent(q)}&count=10&language=es&countryCode=AR`, {
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: 86_400 },
    });
    if (!res.ok) throw new Error(`Geocoding ${res.status}`);
    const json: { results?: Hit[] } = await res.json();
    return NextResponse.json(
      (json.results ?? []).map((r) => ({
        name: r.name,
        // admin2 es el departamento/partido; se omite si repite el nombre
        region: [r.admin2 !== r.name ? r.admin2 : null, r.admin1].filter(Boolean).join(", "),
        lat: r.latitude,
        lon: r.longitude,
        population: r.population ?? null,
      })),
    );
  } catch (e) {
    console.warn("[geocode]", e);
    return NextResponse.json({ error: "Búsqueda no disponible" }, { status: 502 });
  }
}

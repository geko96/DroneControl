import { latToTile, lonToTile, tileToLat, tileToLon, toLatLon, toLocal, type LatLon, type Pt } from "./geo";
import { LAYERS, layerByKey, rampCss, type LayerKey } from "./layers";

/** Nivel de zoom de las teselas de terreno (cada una ≈ 4-5 km de lado). */
export const CHUNK_Z = 13;
/** Las imágenes se piden dos niveles más abajo: 4×4 teselas por bloque. */
export const IMAGERY_DZ = 2;
const TILE_PX = 256;
const LATTICE = 0.05; // grados entre nodos meteorológicos (≈ 5 km)
const LAPSE = 0.0065; // °C por metro
const EARTH = 40_075_016.686;

const ELEVATION_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const IMAGERY_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

export type Weather = {
  temperature: number;
  soilMoisture: number;
  soilTemp: number;
  humidity: number;
  windSpeed: number; // m/s
  windDir: number; // grados, desde donde sopla
};
type WeatherNode = Weather & { elevation: number };

/** Una medición tomada por el dron: posición, radio de la huella en el suelo y valores. */
export type Sample = Pt & { r: number } & Record<LayerKey, number>;

export type LayerStats = { n: number; mean: number; min: number; max: number };

export const chunkKey = (tx: number, ty: number) => `${tx}/${ty}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Mundo sin bordes: relieve por teselas (Terrain Tiles), clima en una retícula global
 * (Open-Meteo) y las mediciones que va dejando el dron. Coordenadas en metros locales
 * respecto a `origin` (x = este, y = norte).
 */
export class World {
  readonly heights = new Map<string, Float32Array>();
  private loading = new Map<string, Promise<Float32Array>>();

  private nodes = new Map<string, WeatherNode>();
  private fetchingWeather = false;
  private weatherRetryAt = 0;
  weatherError = false;

  samples: Sample[] = [];
  private buckets = new Map<string, Sample[]>();
  readonly bucketVersion = new Map<string, number>();
  /** Cambia cuando hay que repintar todas las huellas (capa o rango de colores). */
  paintVersion = 0;
  layerKey: LayerKey | null = "temperature";
  private sums = new Map<LayerKey, number>();
  private ranges = new Map<LayerKey, [number, number]>();
  private lastSample: Pt | null = null;
  private disposed = false;

  constructor(readonly origin: LatLon) {}

  dispose() {
    this.disposed = true;
  }

  // ---------- Relieve ----------

  /** Tesela (con parte fraccionaria) que contiene el punto local. */
  tileAt(x: number, y: number) {
    const ll = toLatLon(this.origin, x, y);
    const fx = lonToTile(ll.lon, CHUNK_Z);
    const fy = latToTile(ll.lat, CHUNK_Z);
    return { tx: Math.floor(fx), ty: Math.floor(fy), fx, fy };
  }

  /** Altura del terreno en m s. n. m.; NaN si esa tesela aún no cargó. */
  ground(x: number, y: number): number {
    const { tx, ty, fx, fy } = this.tileAt(x, y);
    const h = this.heights.get(chunkKey(tx, ty));
    if (!h) return NaN;
    const px = (fx - tx) * (TILE_PX - 1);
    const py = (fy - ty) * (TILE_PX - 1);
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, TILE_PX - 1);
    const y1 = Math.min(y0 + 1, TILE_PX - 1);
    const ax = px - x0;
    const ay = py - y0;
    const top = h[y0 * TILE_PX + x0] * (1 - ax) + h[y0 * TILE_PX + x1] * ax;
    const bottom = h[y1 * TILE_PX + x0] * (1 - ax) + h[y1 * TILE_PX + x1] * ax;
    return top * (1 - ay) + bottom * ay;
  }

  /** Descarga y decodifica una tesela de elevación (formato Terrarium). */
  loadHeights(tx: number, ty: number): Promise<Float32Array> {
    const key = chunkKey(tx, ty);
    const ready = this.heights.get(key);
    if (ready) return Promise.resolve(ready);
    let p = this.loading.get(key);
    if (!p) {
      p = new Promise<Float32Array>((resolve) => {
        const out = new Float32Array(TILE_PX * TILE_PX);
        const done = () => {
          this.heights.set(key, out);
          this.loading.delete(key);
          resolve(out);
        };
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = c.height = TILE_PX;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
          for (let i = 0; i < out.length; i++) {
            // el mar se aplana a cota 0 (Terrarium incluye batimetría)
            out[i] = Math.max(0, d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768);
          }
          done();
        };
        // si la tesela falla se deja plana para no bloquear el vuelo
        img.onerror = () => {
          console.warn(`Sin elevación para la tesela ${key}`);
          done();
        };
        img.src = ELEVATION_URL(CHUNK_Z, tx, ty);
      });
      this.loading.set(key, p);
    }
    return p;
  }

  /** Libera el relieve de teselas lejanas al punto dado. */
  prune(x: number, y: number, keep: number) {
    const c = this.tileAt(x, y);
    for (const key of this.heights.keys()) {
      const [tx, ty] = key.split("/").map(Number);
      if (Math.max(Math.abs(tx - c.tx), Math.abs(ty - c.ty)) > keep) this.heights.delete(key);
    }
  }

  // ---------- Clima y suelo ----------

  /** Pide los nodos de la retícula que falten alrededor del punto. */
  ensureWeather(x: number, y: number) {
    if (this.fetchingWeather || this.disposed || Date.now() < this.weatherRetryAt) return;
    const ll = toLatLon(this.origin, x, y);
    const i0 = Math.floor(ll.lon / LATTICE);
    const j0 = Math.floor(ll.lat / LATTICE);
    const missing: [number, number][] = [];
    for (let j = j0 - 1; j <= j0 + 2; j++) {
      for (let i = i0 - 1; i <= i0 + 2; i++) {
        if (!this.nodes.has(`${i},${j}`)) missing.push([i, j]);
      }
    }
    if (missing.length === 0) return;
    this.fetchingWeather = true;
    const lat = missing.map(([, j]) => (j * LATTICE).toFixed(2)).join(",");
    const lon = missing.map(([i]) => (i * LATTICE).toFixed(2)).join(",");
    fetch(`/api/weather?lat=${lat}&lon=${lon}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list: WeatherNode[]) => {
        missing.forEach(([i, j], n) => list[n] && this.nodes.set(`${i},${j}`, list[n]));
        this.weatherError = false;
      })
      .catch((e) => {
        console.warn("Clima no disponible:", e);
        this.weatherError = true;
        this.weatherRetryAt = Date.now() + 30_000;
      })
      .finally(() => {
        this.fetchingWeather = false;
      });
  }

  /**
   * Clima y suelo interpolados en el punto; null si los nodos vecinos aún no cargaron.
   * Las temperaturas se interpolan reducidas a nivel del mar y se reajustan con la
   * altura real del terreno (gradiente de 6,5 °C/km) para recuperar el detalle del relieve.
   */
  weatherAt(x: number, y: number): Weather | null {
    const ll = toLatLon(this.origin, x, y);
    const fi = ll.lon / LATTICE;
    const fj = ll.lat / LATTICE;
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const a = this.nodes.get(`${i0},${j0}`);
    const b = this.nodes.get(`${i0 + 1},${j0}`);
    const c = this.nodes.get(`${i0},${j0 + 1}`);
    const d = this.nodes.get(`${i0 + 1},${j0 + 1}`);
    if (!a || !b || !c || !d) return null;
    const u = fi - i0;
    const v = fj - j0;
    const mix = (f: (n: WeatherNode) => number) =>
      (f(a) * (1 - u) + f(b) * u) * (1 - v) + (f(c) * (1 - u) + f(d) * u) * v;
    const g = this.ground(x, y);
    const elev = Number.isFinite(g) ? g : mix((n) => n.elevation);
    const near = (u < 0.5 ? (v < 0.5 ? a : c) : v < 0.5 ? b : d);
    return {
      temperature: mix((n) => n.temperature + LAPSE * n.elevation) - LAPSE * elev,
      soilTemp: mix((n) => n.soilTemp + LAPSE * n.elevation) - LAPSE * elev,
      soilMoisture: mix((n) => n.soilMoisture),
      humidity: mix((n) => n.humidity),
      windSpeed: near.windSpeed,
      windDir: near.windDir,
    };
  }

  wind(x: number, y: number) {
    const w = this.weatherAt(x, y);
    return w ? { speed: w.windSpeed, dir: w.windDir } : { speed: 0, dir: 0 };
  }

  // ---------- Mediciones ----------

  /**
   * Toma una medición bajo el dron si está en vuelo y ya se alejó lo suficiente de la anterior.
   * La huella crece con la altura sobre el suelo.
   */
  maybeSample(x: number, y: number, alt: number): Sample | null {
    const g = this.ground(x, y);
    if (!Number.isFinite(g) || alt - g < 5) return null;
    const r = clamp((alt - g) * 0.6, 25, 200);
    if (this.lastSample && Math.hypot(x - this.lastSample.x, y - this.lastSample.y) < r * 0.6) return null;
    const w = this.weatherAt(x, y);
    if (!w) return null;
    const s: Sample = {
      x, y, r,
      elevation: g,
      temperature: w.temperature,
      soilMoisture: w.soilMoisture,
      soilTemp: w.soilTemp,
      humidity: w.humidity,
    };
    this.lastSample = { x, y };
    this.samples.push(s);

    // la huella puede tocar varias teselas
    const lo = this.tileAt(x - r, y + r);
    const hi = this.tileAt(x + r, y - r);
    for (let ty = lo.ty; ty <= hi.ty; ty++) {
      for (let tx = lo.tx; tx <= hi.tx; tx++) {
        const key = chunkKey(tx, ty);
        let b = this.buckets.get(key);
        if (!b) this.buckets.set(key, (b = []));
        b.push(s);
        this.bucketVersion.set(key, (this.bucketVersion.get(key) ?? 0) + 1);
      }
    }

    for (const { key } of LAYERS) {
      const v = s[key];
      this.sums.set(key, (this.sums.get(key) ?? 0) + v);
      const range = this.ranges.get(key);
      if (!range) this.ranges.set(key, [v, v]);
      else if (v < range[0] || v > range[1]) {
        range[0] = Math.min(range[0], v);
        range[1] = Math.max(range[1], v);
        if (key === this.layerKey) this.paintVersion++; // cambió la escala de colores
      }
    }
    return s;
  }

  clearSamples() {
    this.samples = [];
    this.buckets.clear();
    for (const key of this.bucketVersion.keys()) this.bucketVersion.set(key, (this.bucketVersion.get(key) ?? 0) + 1);
    this.sums.clear();
    this.ranges.clear();
    this.lastSample = null;
    this.paintVersion++;
  }

  setLayer(key: LayerKey | null) {
    if (key === this.layerKey) return;
    this.layerKey = key;
    this.paintVersion++;
  }

  stats(key: LayerKey): LayerStats | null {
    const range = this.ranges.get(key);
    const n = this.samples.length;
    if (!range || n === 0) return null;
    return { n, mean: (this.sums.get(key) ?? 0) / n, min: range[0], max: range[1] };
  }

  /** Pinta las huellas de una tesela en su lienzo, coloreadas según la capa activa. */
  paintChunk(ctx: CanvasRenderingContext2D, tx: number, ty: number, size: number) {
    ctx.clearRect(0, 0, size, size);
    const bucket = this.buckets.get(chunkKey(tx, ty));
    const key = this.layerKey;
    const range = key && this.ranges.get(key);
    if (!bucket || !key || !range) return;
    const ramp = layerByKey(key).ramp;
    const span = range[1] - range[0];
    for (const s of bucket) {
      const ll = toLatLon(this.origin, s.x, s.y);
      const px = (lonToTile(ll.lon, CHUNK_Z) - tx) * size;
      const py = (latToTile(ll.lat, CHUNK_Z) - ty) * size;
      const tileM = (EARTH * Math.cos((ll.lat * Math.PI) / 180)) / 2 ** CHUNK_Z;
      ctx.fillStyle = rampCss(ramp, span > 1e-9 ? (s[key] - range[0]) / span : 0.5);
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1.5, (s.r / tileM) * size), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Posición local de un punto de la retícula de teselas (para construir la malla). */
  tilePoint(fx: number, fy: number): Pt {
    return toLocal(this.origin, tileToLat(fy, CHUNK_Z), tileToLon(fx, CHUNK_Z));
  }
}

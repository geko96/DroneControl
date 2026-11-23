export const M_PER_DEG = 111_320;

export type LatLon = { lat: number; lon: number };
export type Pt = { x: number; y: number };

const RAD = Math.PI / 180;

/** Metros locales (x = este, y = norte) respecto a un origen; proyección equirectangular. */
export function toLocal(o: LatLon, lat: number, lon: number): Pt {
  return { x: (lon - o.lon) * M_PER_DEG * Math.cos(o.lat * RAD), y: (lat - o.lat) * M_PER_DEG };
}

export function toLatLon(o: LatLon, x: number, y: number): LatLon {
  return { lat: o.lat + y / M_PER_DEG, lon: o.lon + x / (M_PER_DEG * Math.cos(o.lat * RAD)) };
}

// Coordenadas fraccionarias de tesela Web Mercator (esquema XYZ)
export const lonToTile = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
export const latToTile = (lat: number, z: number) =>
  ((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2) * 2 ** z;
export const tileToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export const tileToLat = (y: number, z: number) =>
  Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / RAD;

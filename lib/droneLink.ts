import { initialState, type DroneState, type FlightMode } from "./sim";
import { toLocal } from "./geo";

export type LinkStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * Enlace con un dron real a través de un puente WebSocket (p. ej. MAVLink → JSON).
 *
 * Telemetría esperada (JSON, campos opcionales salvo lat/lon):
 *   { "lat": -32.59, "lon": -69.35, "alt": 2100, "yaw": 90, "vx": 0, "vy": 0, "vz": 0,
 *     "battery": 87, "armed": true, "mode": "manual" }
 *   alt en m s. n. m., yaw en grados (0 = norte, horario), velocidades en m/s (este, norte, arriba).
 *
 * Comandos enviados:
 *   { "type": "rc", "forward": 0..1, "right": .., "up": .., "yaw": .. }
 *   { "type": "command", "name": "takeoff" | "land" | "rth" }
 *   { "type": "goto", "lat": .., "lon": .. }
 *   { "type": "mission", "agl": 120, "waypoints": [{ "lat": .., "lon": .. }, ...] }
 */
export class DroneLink {
  state: DroneState = initialState();
  status: LinkStatus = "disconnected";
  hasFix = false;
  private ws: WebSocket | null = null;
  private origin = { lat: 0, lon: 0 };

  constructor(private onStatus: (s: LinkStatus) => void) {}

  setOrigin(lat: number, lon: number) {
    this.origin = { lat, lon };
  }

  private setStatus(s: LinkStatus) {
    this.status = s;
    this.onStatus(s);
  }

  connect(url: string) {
    this.disconnect();
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.setStatus("error");
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.setStatus("connected");
    ws.onerror = () => {
      if (this.ws === ws) this.setStatus("error");
    };
    ws.onclose = () => {
      if (this.ws === ws && this.status !== "error") this.setStatus("disconnected");
    };
    ws.onmessage = (ev) => {
      try {
        this.ingest(JSON.parse(ev.data));
      } catch {
        // mensaje no JSON: se ignora
      }
    };
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    this.hasFix = false;
    ws?.close();
    this.setStatus("disconnected");
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ingest(m: Record<string, unknown>) {
    if (typeof m.lat !== "number" || typeof m.lon !== "number") return;
    const s = this.state;
    const p = toLocal(this.origin, m.lat, m.lon);
    s.x = p.x;
    s.y = p.y;
    if (typeof m.alt === "number") s.alt = m.alt;
    if (typeof m.yaw === "number") s.yaw = (m.yaw * Math.PI) / 180;
    if (typeof m.vx === "number") s.vx = m.vx;
    if (typeof m.vy === "number") s.vy = m.vy;
    if (typeof m.vz === "number") s.vz = m.vz;
    if (typeof m.battery === "number") s.battery = m.battery;
    if (typeof m.armed === "boolean") s.armed = m.armed;
    if (typeof m.mode === "string") s.mode = m.mode as FlightMode;
    this.hasFix = true;
  }
}

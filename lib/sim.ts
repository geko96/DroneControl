/** Lo que el simulador necesita saber del entorno. */
export type SimWorld = {
  /** Altura del terreno en m s. n. m.; NaN si aún no se conoce. */
  ground(x: number, y: number): number;
  wind(x: number, y: number): { speed: number; dir: number };
};

export type FlightMode = "ground" | "manual" | "auto" | "scan" | "rth" | "landing";

/** Posición local en metros respecto al origen (la base): x = este, y = norte. */
export type DroneState = {
  x: number;
  y: number;
  alt: number; // m s. n. m.
  yaw: number; // rad, 0 = norte, horario
  vx: number;
  vy: number;
  vz: number;
  battery: number; // %
  armed: boolean;
  mode: FlightMode;
  target: { x: number; y: number } | null;
  /** Avance de la misión de escaneo en [0,1]; null si no hay misión. */
  progress: number | null;
};

export type ControlInput = { forward: number; right: number; up: number; yaw: number };

export const initialState = (): DroneState => ({
  x: 0, y: 0, alt: 0, yaw: 0, vx: 0, vy: 0, vz: 0,
  battery: 100, armed: false, mode: "ground", target: null, progress: null,
});

const MAX_SPEED = 20; // m/s
const SCAN_SPEED = 14;
const MAX_CLIMB = 6;
const TAKEOFF_AGL = 80;
const MIN_AGL = 2;
const MAX_AGL = 1500;
const WIND_DRIFT = 0.25; // fracción del viento que el control no compensa

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export class DroneSim {
  state = initialState();
  private world: SimWorld | null = null;
  private lastGround = 0;
  private aglTarget = TAKEOFF_AGL;
  private mission: { x: number; y: number }[] = [];
  private missionIdx = 0;
  private legStart = { x: 0, y: 0 };

  setWorld(w: SimWorld) {
    this.world = w;
    this.lastGround = 0;
    this.reset();
  }

  reset() {
    this.state = initialState();
    this.state.alt = this.ground(0, 0);
  }

  ground(x: number, y: number): number {
    // mientras el relieve de esa zona no cargó se usa la última altura conocida
    const g = this.world ? this.world.ground(x, y) : NaN;
    if (Number.isFinite(g)) this.lastGround = g;
    return this.lastGround;
  }

  takeoff() {
    const s = this.state;
    if (s.battery <= 0) return;
    s.armed = true;
    s.mode = "auto";
    s.target = { x: s.x, y: s.y };
    this.aglTarget = Math.max(TAKEOFF_AGL, s.alt - this.ground(s.x, s.y));
  }

  land() {
    if (!this.state.armed) return;
    this.state.mode = "landing";
    this.state.target = null;
  }

  returnHome() {
    if (!this.state.armed) return;
    this.state.mode = "rth";
    this.state.target = { x: 0, y: 0 };
    this.aglTarget = Math.max(TAKEOFF_AGL, this.state.alt - this.ground(this.state.x, this.state.y));
  }

  /** Recorre los puntos en orden a la altura sobre el suelo indicada y vuelve a base al terminar. */
  startMission(path: { x: number; y: number }[], agl: number) {
    const s = this.state;
    if (path.length === 0 || s.battery <= 0) return;
    s.armed = true;
    s.mode = "scan";
    this.mission = path;
    this.missionIdx = 0;
    this.legStart = { x: s.x, y: s.y };
    this.aglTarget = agl;
    s.target = path[0];
    s.progress = 0;
  }

  goTo(x: number, y: number) {
    const s = this.state;
    if (s.battery <= 0) return;
    if (!s.armed) this.takeoff();
    else this.aglTarget = Math.max(60, s.alt - this.ground(s.x, s.y));
    s.mode = "auto";
    s.target = { x, y };
  }

  step(dt: number, input: ControlInput) {
    const t = this.world;
    const s = this.state;
    if (!t) return;
    if (!s.armed) {
      s.alt = this.ground(s.x, s.y); // se apoya en el suelo aunque el relieve cargue después
      return;
    }

    const manualInput =
      Math.abs(input.forward) + Math.abs(input.right) + Math.abs(input.up) + Math.abs(input.yaw) > 0.01;
    // Cualquier mando manual cancela el piloto automático (salvo batería agotada).
    if (manualInput && s.mode !== "manual" && s.battery > 0) {
      s.mode = "manual";
      s.target = null;
    }

    const g = this.ground(s.x, s.y);
    const agl = s.alt - g;
    let tvx = 0;
    let tvy = 0;
    let tvz = 0;

    if (s.mode === "manual") {
      const sin = Math.sin(s.yaw);
      const cos = Math.cos(s.yaw);
      tvx = (input.forward * sin + input.right * cos) * MAX_SPEED;
      tvy = (input.forward * cos - input.right * sin) * MAX_SPEED;
      tvz = input.up * MAX_CLIMB;
      if (agl >= MAX_AGL) tvz = Math.min(tvz, 0);
      s.yaw += input.yaw * 1.2 * dt;
    } else if ((s.mode === "auto" || s.mode === "scan" || s.mode === "rth") && s.target) {
      const dx = s.target.x - s.x;
      const dy = s.target.y - s.y;
      const dist = Math.hypot(dx, dy);
      const aglErr = this.aglTarget - agl;
      tvz = clamp(aglErr * 0.8, -MAX_CLIMB, MAX_CLIMB + 2);
      if (s.mode === "scan") {
        // avance continuo: tramos completados + fracción del tramo actual
        const leg = Math.hypot(s.target.x - this.legStart.x, s.target.y - this.legStart.y) || 1;
        s.progress = (this.missionIdx + clamp(1 - dist / leg, 0, 1)) / this.mission.length;
      }
      if (dist > 5) {
        const speed = Math.min(s.mode === "scan" ? SCAN_SPEED : MAX_SPEED, dist * 0.4 + 2);
        tvx = (dx / dist) * speed;
        tvy = (dy / dist) * speed;
        const want = Math.atan2(dx, dy);
        const diff = Math.atan2(Math.sin(want - s.yaw), Math.cos(want - s.yaw));
        s.yaw += clamp(diff, -1.5 * dt, 1.5 * dt);
      } else if (s.mode === "scan") {
        this.missionIdx++;
        this.legStart = { x: s.x, y: s.y };
        s.progress = this.missionIdx / this.mission.length;
        if (this.missionIdx < this.mission.length) s.target = this.mission[this.missionIdx];
        else this.returnHome();
      } else if (s.mode === "rth") {
        s.mode = "landing";
        s.target = null;
      } else if (Math.abs(aglErr) < 3) {
        s.mode = "manual"; // llegó: queda en estacionario
        s.target = null;
      }
    } else if (s.mode === "landing") {
      tvz = -clamp(agl * 0.5, 1, 4);
    }

    const a = Math.min(1, dt * 2);
    s.vx += (tvx - s.vx) * a;
    s.vy += (tvy - s.vy) * a;
    s.vz += (tvz - s.vz) * a;

    // Viento: dirección meteorológica = desde donde sopla.
    const wind = t.wind(s.x, s.y);
    const wr = (wind.dir * Math.PI) / 180;
    // Solo deriva con mando manual activo; sin mandos o en automático mantiene posición.
    const drift = s.mode === "manual" && manualInput ? WIND_DRIFT : 0;
    const wx = -Math.sin(wr) * wind.speed * drift;
    const wy = -Math.cos(wr) * wind.speed * drift;

    s.x += (s.vx + wx) * dt;
    s.y += (s.vy + wy) * dt;
    s.alt += s.vz * dt;

    const g2 = this.ground(s.x, s.y);
    if (s.mode === "landing" && s.alt <= g2 + MIN_AGL) {
      s.armed = false;
      s.mode = "ground";
      s.alt = g2;
      s.vx = s.vy = s.vz = 0;
      return;
    }
    s.alt = Math.max(s.alt, g2 + MIN_AGL);

    // Batería casi infinita: ~1 % cada media hora de vuelo.
    s.battery = Math.max(0, s.battery - dt * (0.0005 + 0.00004 * Math.hypot(s.vx, s.vy)));
    if (s.battery <= 0 && s.mode !== "landing") this.land();
    else if (s.battery < 10 && s.mode !== "rth" && s.mode !== "landing") this.returnHome();
  }
}

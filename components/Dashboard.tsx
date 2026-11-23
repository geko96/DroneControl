"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DroneLink, type LinkStatus } from "../lib/droneLink";
import { toLatLon, type Pt } from "../lib/geo";
import { LAYERS, layerByKey, type LayerKey } from "../lib/layers";
import { coveragePath, pathLength, polygonArea, shapePolygon, type ZoneKind } from "../lib/scan";
import { DroneSim, type ControlInput, type DroneState, type FlightMode } from "../lib/sim";
import { World, type LayerStats, type Weather } from "../lib/world";
import Sparkline from "./Sparkline";

const Scene3D = dynamic(() => import("./Scene3D"), { ssr: false });

type Mode = "sim" | "drone";
type Place = { name: string; region: string; lat: number; lon: number; population: number | null };

const START = { name: "Uspallata", lat: -32.59, lon: -69.35 };

const MODE_LABEL: Record<FlightMode, string> = {
  ground: "En tierra",
  manual: "Manual",
  auto: "Automático",
  scan: "Escaneando",
  rth: "Volviendo a base",
  landing: "Aterrizando",
};

const LINK_LABEL: Record<LinkStatus, string> = {
  disconnected: "Sin conexión",
  connecting: "Conectando…",
  connected: "Conectado",
  error: "Error de conexión",
};

const ZONE_KINDS: { kind: ZoneKind; label: string; hint: string }[] = [
  { kind: "rect", label: "Rectángulo", hint: "Marca dos esquinas opuestas sobre el terreno." },
  { kind: "circle", label: "Círculo", hint: "Marca el centro y luego un punto del borde." },
  { kind: "poly", label: "Polígono", hint: "Marca los vértices uno a uno y pulsa «Cerrar polígono»." },
];

const SCAN_SPEED = 14; // m/s, para estimar la duración
const SAMPLE_S = 0.25;
const HISTORY = 240; // 60 s

type Telemetry = {
  lat: number;
  lon: number;
  alt: number;
  /** null mientras no cargó el relieve bajo el dron. */
  agl: number | null;
  speed: number;
  heading: number;
  battery: number;
  mode: string;
  scanning: boolean;
  progress: number | null;
  weather: Weather | null;
};

function telemetryFrom(s: DroneState, w: World): Telemetry {
  const ground = w.ground(s.x, s.y);
  return {
    ...toLatLon(w.origin, s.x, s.y),
    alt: s.alt,
    agl: Number.isFinite(ground) ? s.alt - ground : null,
    speed: Math.hypot(s.vx, s.vy),
    heading: (((s.yaw * 180) / Math.PI) % 360 + 360) % 360,
    battery: s.battery,
    mode: MODE_LABEL[s.mode] ?? s.mode,
    scanning: s.mode === "scan",
    progress: s.progress ?? null,
    weather: w.weatherAt(s.x, s.y),
  };
}

const KEYMAP: Record<string, [keyof ControlInput, number]> = {
  w: ["forward", 1], s: ["forward", -1],
  d: ["right", 1], a: ["right", -1],
  r: ["up", 1], f: ["up", -1],
  e: ["yaw", 1], q: ["yaw", -1],
};

/** Buscador de localidades de Argentina. */
function PlaceSearch({ onSelect }: { onSelect: (p: Place) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setState("idle");
      return;
    }
    const ctrl = new AbortController();
    setState("loading");
    const id = setTimeout(() => {
      fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((list: Place[]) => {
          setResults(list);
          setState("idle");
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setState("error");
        });
    }, 300);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [query]);

  return (
    <div className="search">
      <label>
        Buscar localidad de Argentina
        <input
          type="search"
          value={query}
          placeholder="Ej.: Cachi, Tilcara, El Bolsón…"
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
      </label>
      {state === "loading" && <p className="note">Buscando…</p>}
      {state === "error" && <p className="note bad">⚠ La búsqueda no está disponible ahora.</p>}
      {state === "idle" && results?.length === 0 && <p className="note">Sin resultados para «{query.trim()}».</p>}
      {state !== "error" && results && results.length > 0 && (
        <ul className="results">
          {results.map((p) => (
            <li key={`${p.lat},${p.lon}`}>
              <button
                onClick={() => {
                  onSelect(p);
                  setQuery("");
                }}
              >
                <strong>{p.name}</strong>
                <span>{p.region}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [mode, setMode] = useState<Mode>("sim");
  const [loc, setLoc] = useState(START);
  const [form, setForm] = useState({ lat: String(START.lat), lon: String(START.lon) });
  const [formError, setFormError] = useState<string | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [layerKey, setLayerKey] = useState<LayerKey | null>("temperature");
  const [layerOpacity, setLayerOpacity] = useState(0.7);
  const [draft, setDraft] = useState<{ kind: ZoneKind; pts: Pt[] } | null>(null);
  const [zone, setZone] = useState<Pt[] | null>(null);
  const [spacing, setSpacing] = useState(150);
  const [scanAgl, setScanAgl] = useState(120);
  const [exaggeration, setExaggeration] = useState(1.5);
  const [warp, setWarp] = useState(1);
  const [follow, setFollow] = useState(true);
  const [tel, setTel] = useState<Telemetry | null>(null);
  const [hist, setHist] = useState<Telemetry[]>([]);
  const [stats, setStats] = useState<Partial<Record<LayerKey, LayerStats>>>({});
  const [weatherError, setWeatherError] = useState(false);
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("disconnected");
  const [wsUrl, setWsUrl] = useState("ws://localhost:8765");

  const [sim] = useState(() => new DroneSim());
  const [link] = useState(() => new DroneLink(setLinkStatus));
  const keys = useRef(new Set<string>());
  const pad = useRef<ControlInput>({ forward: 0, right: 0, up: 0, yaw: 0 });

  const readInput = useCallback((): ControlInput => {
    const out = { ...pad.current };
    for (const k of keys.current) {
      const m = KEYMAP[k];
      if (m) out[m[0]] += m[1];
    }
    return out;
  }, []);

  // Un mundo nuevo por cada lugar elegido: el dron parte de ese punto
  useEffect(() => {
    const w = new World({ lat: loc.lat, lon: loc.lon });
    sim.setWorld(w);
    link.setOrigin(loc.lat, loc.lon);
    setWorld(w);
    setZone(null);
    setDraft(null);
    return () => w.dispose();
  }, [loc, sim, link]);

  useEffect(() => {
    world?.setLayer(layerKey);
  }, [world, layerKey]);

  // Teclado
  useEffect(() => {
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
    const down = (e: KeyboardEvent) => {
      if (!typing(e) && !e.ctrlKey && !e.metaKey) keys.current.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const clear = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);

  const getState = useCallback(
    () => (mode === "sim" ? sim.state : link.hasFix ? link.state : null),
    [mode, sim, link],
  );

  // Muestreo de telemetría (y envío de mandos al dron real)
  useEffect(() => {
    setHist([]);
    setTel(null);
    setStats({});
    if (!world) return;
    let wasActive = false;
    const id = setInterval(() => {
      if (mode === "drone" && link.status === "connected") {
        const input = readInput();
        const active = Object.values(input).some((v) => v !== 0);
        // se envía un último mensaje en cero al soltar los mandos
        if (active || wasActive) link.send({ type: "rc", ...input });
        wasActive = active;
      }
      const s = getState();
      world.ensureWeather(s?.x ?? 0, s?.y ?? 0);
      setWeatherError(world.weatherError);
      setStats(Object.fromEntries(LAYERS.map((l) => [l.key, world.stats(l.key)]).filter(([, v]) => v)));
      if (!s) {
        setTel(null);
        return;
      }
      const t = telemetryFrom(s, world);
      setTel(t);
      setHist((h) => (h.length >= HISTORY ? [...h.slice(1), t] : [...h, t]));
    }, SAMPLE_S * 1000);
    return () => clearInterval(id);
  }, [mode, world, getState, link, readInput]);

  const onFrame = (dt: number) => {
    if (mode === "sim") {
      const input = readInput();
      for (let i = 0; i < warp; i++) sim.step(dt, input);
    }
    // el dron mide el terreno que va sobrevolando
    const s = getState();
    if (s?.armed && world) world.maybeSample(s.x, s.y, s.alt);
  };

  const connected = linkStatus === "connected";
  const canCommand = mode === "sim" ? !!world : connected;

  const command = (name: "takeoff" | "land" | "rth") => {
    if (mode === "drone") return link.send({ type: "command", name });
    if (name === "takeoff") sim.takeoff();
    else if (name === "land") sim.land();
    else sim.returnHome();
  };

  const path = useMemo(() => (zone ? coveragePath(zone, spacing) : null), [zone, spacing]);

  const finishZone = (kind: ZoneKind, pts: Pt[]) => {
    const poly = shapePolygon(kind, pts);
    setDraft(null);
    if (polygonArea(poly) > 1) setZone(poly);
  };

  const startScan = () => {
    if (!world || !path || path.length === 0 || !canCommand) return;
    if (mode === "sim") sim.startMission(path, scanAgl);
    else link.send({ type: "mission", agl: scanAgl, waypoints: path.map((p) => toLatLon(world.origin, p.x, p.y)) });
  };

  const onPick = (x: number, y: number) => {
    if (!world) return;
    if (draft) {
      const pts = [...draft.pts, { x, y }];
      if (draft.kind !== "poly" && pts.length === 2) finishZone(draft.kind, pts);
      else setDraft({ ...draft, pts });
      return;
    }
    if (!canCommand) return;
    if (mode === "sim") return sim.goTo(x, y);
    link.send({ type: "goto", ...toLatLon(world.origin, x, y) });
  };

  const padBtn = (axis: keyof ControlInput, value: number, label: string, title: string) => {
    const release = () => {
      pad.current[axis] = 0;
    };
    return (
      <button
        className="pad-btn"
        title={title}
        aria-label={title}
        disabled={!canCommand}
        onPointerDown={() => {
          pad.current[axis] = value;
        }}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
      >
        {label}
      </button>
    );
  };

  const goToCoords = () => {
    const lat = Number(form.lat);
    const lon = Number(form.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 84 || Math.abs(lon) > 180) {
      setFormError("Coordenadas inválidas");
      return;
    }
    setFormError(null);
    setLoc({ name: "Coordenadas", lat, lon });
  };

  const selectPlace = (p: Place) => {
    setFormError(null);
    setForm({ lat: p.lat.toFixed(4), lon: p.lon.toFixed(4) });
    setLoc({ name: p.name, lat: p.lat, lon: p.lon });
  };

  const layer = layerKey && layerByKey(layerKey);
  const layerStats = layerKey ? stats[layerKey] : undefined;
  const sampleCount = stats.elevation?.n ?? 0;
  const zoneArea = zone ? polygonArea(zone) : 0;
  const routeLen = path ? pathLength(path) : 0;
  const drawHint = draft && ZONE_KINDS.find((z) => z.kind === draft.kind)!.hint;
  const lowBattery = !!tel && tel.battery < 20;
  const progress = tel?.progress ?? null;
  const series = (f: (w: Weather) => number) => hist.flatMap((h) => (h.weather ? [f(h.weather)] : []));

  return (
    <div className="app">
      <header className="topbar">
        <h1>Control de dron</h1>
        <div className="seg" role="radiogroup" aria-label="Modo">
          {(["sim", "drone"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m === "sim" ? "Simulación" : "Dron"}
            </button>
          ))}
        </div>
        <span className={`pill ${mode === "drone" && !connected ? "warn" : ""}`}>
          {mode === "sim" ? "Simulación activa" : `Dron real · ${LINK_LABEL[linkStatus]}`}
        </span>
      </header>

      <aside className="panel left">
        <section>
          <h2>Lugar</h2>
          <p className="place">{loc.name}</p>
          <PlaceSearch onSelect={selectPlace} />
          <div className="row">
            <label>
              Latitud
              <input value={form.lat} inputMode="decimal" onChange={(e) => setForm((d) => ({ ...d, lat: e.target.value }))} />
            </label>
            <label>
              Longitud
              <input value={form.lon} inputMode="decimal" onChange={(e) => setForm((d) => ({ ...d, lon: e.target.value }))} />
            </label>
          </div>
          <button onClick={goToCoords}>Ir a estas coordenadas</button>
          {formError && <p className="note bad">⚠ {formError}</p>}
          <p className="note">
            El mapa no tiene bordes: el terreno se va cargando alrededor del dron mientras vuela. Al cambiar de lugar se
            reinician el dron y las mediciones.
          </p>
          <p className={`note ${weatherError ? "bad" : ""}`}>
            Relieve: Terrain Tiles (SRTM) · Imágenes: Esri World Imagery
            <br />
            Clima y suelo: {weatherError ? "⚠ Open-Meteo no responde; se reintenta" : "modelo Open-Meteo"}
          </p>
        </section>

        <section>
          <h2>Zona de escaneo</h2>
          <div className="seg small" role="group" aria-label="Forma de la zona">
            {ZONE_KINDS.map((z) => (
              <button
                key={z.kind}
                className={draft?.kind === z.kind ? "on" : ""}
                disabled={!world}
                onClick={() => setDraft(draft?.kind === z.kind ? null : { kind: z.kind, pts: [] })}
              >
                {z.label}
              </button>
            ))}
          </div>
          {draft && (
            <>
              <p className="note active">{drawHint}</p>
              <div className="actions">
                {draft.kind === "poly" && (
                  <button className="primary" disabled={draft.pts.length < 3} onClick={() => finishZone("poly", draft.pts)}>
                    Cerrar polígono
                  </button>
                )}
                <button onClick={() => setDraft(null)}>Cancelar</button>
              </div>
            </>
          )}
          {!draft && !zone && <p className="note">Elige una forma y dibuja sobre el terreno la zona que el dron debe barrer.</p>}
          {zone && !draft && (
            <>
              <label>
                Separación entre pasadas: {spacing} m
                <input type="range" min={30} max={600} step={10} value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
              </label>
              <label>
                Altura de vuelo: {scanAgl} m sobre el suelo
                <input type="range" min={40} max={400} step={10} value={scanAgl} onChange={(e) => setScanAgl(Number(e.target.value))} />
              </label>
              <p className="note">
                Área: {zoneArea >= 1e6 ? `${(zoneArea / 1e6).toFixed(2)} km²` : `${(zoneArea / 1e4).toFixed(1)} ha`}
                {" · "}Ruta: {(routeLen / 1000).toFixed(1)} km en {path ? path.length / 2 : 0} pasadas
                {" · "}≈ {Math.max(1, Math.round(routeLen / SCAN_SPEED / 60))} min
              </p>
              <div className="actions">
                <button className="primary" disabled={!canCommand || !path?.length} onClick={startScan}>
                  {tel?.scanning ? "Reiniciar escaneo" : "Iniciar escaneo"}
                </button>
                <button onClick={() => setZone(null)}>Borrar zona</button>
              </div>
              {progress !== null && (
                <div className="scan">
                  <div className="status-row">
                    <span>{tel?.scanning ? "Escaneando" : progress >= 1 ? "Escaneo completo" : "Escaneo interrumpido"}</span>
                    <span className="batt-text">{(progress * 100).toFixed(0)} %</span>
                  </div>
                  <div className="meter" role="meter" aria-label="Progreso del escaneo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress * 100}>
                    <div style={{ width: `${progress * 100}%` }} />
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <section>
          <h2>Vista</h2>
          <label>
            Exageración vertical ×{exaggeration}
            <input type="range" min={1} max={4} step={0.5} value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))} />
          </label>
          {layer && (
            <label>
              Opacidad de las mediciones: {Math.round(layerOpacity * 100)} %
              <input type="range" min={0.2} max={1} step={0.05} value={layerOpacity} onChange={(e) => setLayerOpacity(Number(e.target.value))} />
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Cámara sigue al dron
          </label>
          {mode === "sim" && (
            <label>
              Velocidad del tiempo
              <div className="seg small">
                {[1, 4, 10].map((w) => (
                  <button key={w} className={warp === w ? "on" : ""} onClick={() => setWarp(w)}>×{w}</button>
                ))}
              </div>
            </label>
          )}
        </section>

        {mode === "drone" && (
          <section>
            <h2>Enlace</h2>
            <label>
              Puente WebSocket
              <input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} spellCheck={false} />
            </label>
            {connected || linkStatus === "connecting" ? (
              <button onClick={() => link.disconnect()}>Desconectar</button>
            ) : (
              <button className="primary" onClick={() => link.connect(wsUrl)}>Conectar</button>
            )}
            <p className="note">
              Estado: {LINK_LABEL[linkStatus]}. El formato de mensajes está documentado en lib/droneLink.ts.
            </p>
          </section>
        )}
      </aside>

      <main className="stage">
        {world && (
          <Scene3D
            world={world}
            exaggeration={exaggeration}
            layerOpacity={layerOpacity}
            zone={zone}
            path={path}
            draft={draft}
            follow={follow}
            getState={getState}
            onFrame={onFrame}
            onPick={onPick}
          />
        )}
        {world && mode === "drone" && !tel && (
          <div className="stage-msg float">Sin telemetría del dron. Conecta el puente WebSocket en el panel «Enlace».</div>
        )}
        <div className="overlay top">
          <div className="seg small" role="radiogroup" aria-label="Medición mostrada">
            <button role="radio" aria-checked={layerKey === null} className={layerKey === null ? "on" : ""} onClick={() => setLayerKey(null)}>
              Solo satélite
            </button>
            {LAYERS.map((l) => (
              <button key={l.key} role="radio" aria-checked={layerKey === l.key} className={layerKey === l.key ? "on" : ""} onClick={() => setLayerKey(l.key)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
        {layer && (
          <div className="overlay legend">
            <div className="legend-title">{layer.label} medida <small>{layer.unit}</small></div>
            {layerStats ? (
              <>
                <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${layer.ramp.join(", ")})` }} />
                <div className="legend-ends">
                  <span>{layer.format(layerStats.min)}</span>
                  <span>{layer.format(layerStats.max)}</span>
                </div>
              </>
            ) : (
              <div className="legend-empty">Despega y vuela: el dron irá pintando lo que mide.</div>
            )}
          </div>
        )}
        <div className="overlay hint">
          {draft ? "Clic en el terreno: marcar punto de la zona" : "Clic en el terreno: enviar el dron"} · Arrastrar: orbitar · Rueda: zoom
          <br />
          Imágenes © Esri, Maxar, Earthstar Geographics
        </div>
      </main>

      <aside className="panel right">
        <section>
          <h2>Estado</h2>
          <div className="status-row">
            <span className="mode">{tel ? tel.mode : "—"}</span>
            <span className="batt-text">
              {lowBattery && "⚠ Batería baja · "}
              {tel ? `${tel.battery.toFixed(0)} %` : "—"}
            </span>
          </div>
          <div className="meter" role="meter" aria-label="Batería" aria-valuemin={0} aria-valuemax={100} aria-valuenow={tel?.battery ?? 0}>
            <div className={lowBattery ? "low" : ""} style={{ width: `${tel?.battery ?? 0}%` }} />
          </div>
          <div className="tiles">
            <Tile label="Altura sobre el suelo" value={tel?.agl?.toFixed(0)} unit="m" />
            <Tile label="Altitud" value={tel?.alt.toFixed(0)} unit="m s. n. m." />
            <Tile label="Velocidad" value={tel?.speed.toFixed(1)} unit="m/s" />
            <Tile label="Rumbo" value={tel?.heading.toFixed(0)} unit="°" />
            <Tile label="Latitud" value={tel?.lat.toFixed(5)} unit="" />
            <Tile label="Longitud" value={tel?.lon.toFixed(5)} unit="" />
          </div>
          {tel?.weather && (
            <p className="note">
              Viento: {tel.weather.windSpeed.toFixed(1)} m/s desde {tel.weather.windDir.toFixed(0)}°
            </p>
          )}
        </section>

        <section>
          <h2>Bajo el dron</h2>
          <div className="sparks">
            <Sparkline label="Temperatura" unit="°C" interval={SAMPLE_S} values={series((w) => w.temperature)} format={(v) => v.toFixed(1)} />
            <Sparkline label="Humedad del suelo" unit="m³/m³" interval={SAMPLE_S} values={series((w) => w.soilMoisture)} format={(v) => v.toFixed(3)} />
            <Sparkline label="Temp. del suelo" unit="°C" interval={SAMPLE_S} values={series((w) => w.soilTemp)} format={(v) => v.toFixed(1)} />
            <Sparkline label="Altura sobre el suelo" unit="m" interval={SAMPLE_S} values={hist.flatMap((h) => (h.agl === null ? [] : [h.agl]))} format={(v) => v.toFixed(0)} />
          </div>
        </section>

        <section>
          <h2>Mediciones</h2>
          {sampleCount === 0 ? (
            <p className="note">Aún no hay mediciones. El dron mide el terreno que sobrevuela mientras está en el aire.</p>
          ) : (
            <>
              <table className="stats">
                <thead>
                  <tr><th>{sampleCount} puntos</th><th>Media</th><th>Mín.</th><th>Máx.</th></tr>
                </thead>
                <tbody>
                  {LAYERS.map((l) => {
                    const st = stats[l.key];
                    return st && (
                      <tr key={l.key}>
                        <th>{l.label} <small>{l.unit}</small></th>
                        <td>{l.format(st.mean)}</td>
                        <td>{l.format(st.min)}</td>
                        <td>{l.format(st.max)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button onClick={() => world?.clearSamples()}>Borrar mediciones</button>
            </>
          )}
        </section>

        <section>
          <h2>Mandos</h2>
          <div className="actions">
            <button className="primary" disabled={!canCommand} onClick={() => command("takeoff")}>Despegar</button>
            <button disabled={!canCommand} onClick={() => command("land")}>Aterrizar</button>
            <button disabled={!canCommand} onClick={() => command("rth")}>Volver a base</button>
            {mode === "sim" && <button onClick={() => sim.reset()}>Reiniciar</button>}
          </div>
          <div className="pads">
            <div className="pad">
              {padBtn("yaw", -1, "⟲", "Girar a la izquierda (Q)")}
              {padBtn("forward", 1, "↑", "Adelante (W)")}
              {padBtn("yaw", 1, "⟳", "Girar a la derecha (E)")}
              {padBtn("right", -1, "←", "Izquierda (A)")}
              {padBtn("forward", -1, "↓", "Atrás (S)")}
              {padBtn("right", 1, "→", "Derecha (D)")}
            </div>
            <div className="pad col">
              {padBtn("up", 1, "▲", "Subir (R)")}
              {padBtn("up", -1, "▼", "Bajar (F)")}
            </div>
          </div>
          <p className="note">Teclado: W/S avanzar · A/D lateral · Q/E girar · R/F subir y bajar.</p>
        </section>
      </aside>
    </div>
  );
}

function Tile({ label, value, unit }: { label: string; value: string | undefined; unit: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">
        {value ?? "—"} {value && unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

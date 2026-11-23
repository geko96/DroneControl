"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Pt } from "../lib/geo";
import { shapePolygon, type ZoneKind } from "../lib/scan";
import type { DroneState } from "../lib/sim";
import { CHUNK_Z, chunkKey, IMAGERY_DZ, IMAGERY_URL, type World } from "../lib/world";

/** Unidades de escena por metro. */
export const K = 0.01;
const SEG = 64; // segmentos por lado de cada tesela
const SKIRT = 2.5; // profundidad del faldón que tapa las juntas entre teselas
const VIEW_R = 2; // teselas visibles alrededor de la cámara (5×5)
const IMAGERY_PX = 1024;
const OVERLAY_PX = 512;

export type Draft = { kind: ZoneKind; pts: Pt[] };

export type WorldProps = {
  world: World;
  exaggeration: number;
  /** Opacidad de las huellas de medición sobre la imagen. */
  layerOpacity: number;
  /** Zona de escaneo ya definida (polígono cerrado) y su ruta de barrido. */
  zone: Pt[] | null;
  path: Pt[] | null;
  /** Zona en proceso de dibujo. */
  draft: Draft | null;
  getState: () => DroneState | null;
  /** Clic sobre el terreno, en metros locales (este, norte). */
  onPick: (x: number, y: number) => void;
};

export function useScale(world: World, exaggeration: number) {
  return useMemo(
    () => ({
      k: K,
      toY: (alt: number) => alt * K * exaggeration,
      groundAt: (x: number, y: number) => {
        const g = world.ground(x, y);
        return Number.isFinite(g) ? g : 0;
      },
    }),
    [world, exaggeration],
  );
}

const toPt = (e: ThreeEvent<MouseEvent>): Pt => ({ x: e.point.x / K, y: -e.point.z / K });

type ChunkProps = Pick<WorldProps, "world" | "exaggeration" | "layerOpacity" | "onPick"> & {
  tx: number;
  ty: number;
  drawing: boolean;
  onHover: (p: Pt | null) => void;
  onLoaded: () => void;
};

/** Una tesela del mundo: relieve + imagen satelital + huellas de medición. */
function Chunk({ world, tx, ty, exaggeration, layerOpacity, drawing, onPick, onHover, onLoaded }: ChunkProps) {
  const key = chunkKey(tx, ty);
  const [heights, setHeights] = useState<Float32Array | null>(() => world.heights.get(key) ?? null);
  const [hasOverlay, setHasOverlay] = useState(false);
  const painted = useRef({ bucket: -1, paint: -1 });

  useEffect(() => {
    let cancelled = false;
    world.loadHeights(tx, ty).then((h) => {
      if (cancelled) return;
      setHeights(h);
      onLoaded();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, tx, ty]);

  // Imagen satelital: mosaico de 4×4 teselas de Esri que se va completando a medida que llegan
  const imagery = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = IMAGERY_PX;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3b4046";
    ctx.fillRect(0, 0, IMAGERY_PX, IMAGERY_PX);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return { ctx, texture };
  }, []);

  useEffect(() => {
    const n = 2 ** IMAGERY_DZ;
    const size = IMAGERY_PX / n;
    const images: HTMLImageElement[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          imagery.ctx.drawImage(img, i * size, j * size, size, size);
          imagery.texture.needsUpdate = true;
        };
        img.src = IMAGERY_URL(CHUNK_Z + IMAGERY_DZ, tx * n + i, ty * n + j);
        images.push(img);
      }
    }
    return () => {
      for (const img of images) {
        img.onload = null;
        img.src = ""; // cancela las descargas pendientes
      }
      imagery.texture.dispose();
    };
  }, [imagery, tx, ty]);

  // Lienzo de huellas: se crea recién cuando el dron midió algo en esta tesela
  const overlay = useMemo(() => {
    if (!hasOverlay) return null;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = OVERLAY_PX;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { ctx: canvas.getContext("2d")!, texture };
  }, [hasOverlay]);
  useEffect(() => () => overlay?.texture.dispose(), [overlay]);

  useFrame(() => {
    const bucket = world.bucketVersion.get(key);
    if (bucket === undefined) return;
    if (!overlay) {
      if (!hasOverlay) setHasOverlay(true);
      return;
    }
    if (painted.current.bucket === bucket && painted.current.paint === world.paintVersion) return;
    painted.current = { bucket, paint: world.paintVersion };
    world.paintChunk(overlay.ctx, tx, ty, OVERLAY_PX);
    overlay.texture.needsUpdate = true;
  });

  const geometry = useMemo(() => {
    if (!heights) return null;
    const side = SEG + 1;
    const ring = SEG * 4;
    const pos = new Float32Array((side * side + ring) * 3);
    const uv = new Float32Array((side * side + ring) * 2);
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const o = j * side + i;
        const p = world.tilePoint(tx + i / SEG, ty + j / SEG);
        const h = heights[Math.round((j / SEG) * 255) * 256 + Math.round((i / SEG) * 255)];
        pos.set([p.x * K, h * K * exaggeration, -p.y * K], o * 3);
        uv.set([i / SEG, 1 - j / SEG], o * 2); // la fila 0 de la tesela es su borde norte
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * side + i;
        idx.push(a, a + side, a + 1, a + 1, a + side, a + side + 1);
      }
    }
    // Faldón: una copia hundida del borde, que oculta las juntas con las teselas vecinas
    const edge: number[] = [];
    for (let i = 0; i < SEG; i++) edge.push(i);
    for (let j = 0; j < SEG; j++) edge.push(j * side + SEG);
    for (let i = SEG; i > 0; i--) edge.push(SEG * side + i);
    for (let j = SEG; j > 0; j--) edge.push(j * side);
    const base = side * side;
    edge.forEach((e, n) => {
      pos.set([pos[e * 3], pos[e * 3 + 1] - SKIRT, pos[e * 3 + 2]], (base + n) * 3);
      uv.set([uv[e * 2], uv[e * 2 + 1]], (base + n) * 2);
      const e2 = edge[(n + 1) % ring];
      const s2 = base + ((n + 1) % ring);
      idx.push(e, base + n, e2, e2, base + n, s2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [world, heights, tx, ty, exaggeration]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) return null;

  return (
    <group>
      <mesh
        geometry={geometry}
        onClick={(e) => {
          if (e.delta > 4) return; // fue un arrastre de cámara, no un clic
          e.stopPropagation();
          const p = toPt(e);
          onPick(p.x, p.y);
        }}
        onPointerMove={drawing ? (e) => onHover(toPt(e)) : undefined}
      >
        <meshStandardMaterial map={imagery.texture} roughness={1} metalness={0} side={THREE.DoubleSide} />
      </mesh>
      {overlay && (
        <mesh geometry={geometry} raycast={() => null} renderOrder={1}>
          <meshBasicMaterial
            map={overlay.texture}
            transparent
            opacity={layerOpacity}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </mesh>
      )}
    </group>
  );
}

/** Terreno sin bordes: monta las teselas cercanas a la cámara y al dron, y dibuja la zona de escaneo. */
export default function World3D({ world, exaggeration, layerOpacity, zone, path, draft, getState, onPick }: WorldProps) {
  const scale = useScale(world, exaggeration);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const [keys, setKeys] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(0); // cuenta teselas cargadas, para re-proyectar las líneas
  const [hover, setHover] = useState<Pt | null>(null);
  const current = useRef("");
  const timer = useRef(1);

  useFrame((_, dt) => {
    timer.current += dt;
    if (timer.current < 0.25) return;
    timer.current = 0;
    const need = new Set<string>();
    const around = (x: number, y: number, r: number) => {
      const c = world.tileAt(x, y);
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) need.add(chunkKey(c.tx + i, c.ty + j));
      return c;
    };
    const s = getState();
    if (s) around(s.x, s.y, 1); // el dron siempre necesita relieve debajo
    const cx = controls ? controls.target.x / K : (s?.x ?? 0);
    const cy = controls ? -controls.target.z / K : (s?.y ?? 0);
    const c = around(cx, cy, VIEW_R);
    // histéresis: las ya montadas se conservan un anillo más, para no recargarlas al ir y volver
    for (const k of current.current ? current.current.split(",") : []) {
      const [tx, ty] = k.split("/").map(Number);
      if (Math.max(Math.abs(tx - c.tx), Math.abs(ty - c.ty)) <= VIEW_R + 1) need.add(k);
    }
    const next = [...need].sort().join(",");
    if (next !== current.current) {
      current.current = next;
      setKeys(next.split(","));
      world.prune(cx, cy, VIEW_R + 3);
    }
  });

  // Proyecta una polilínea en metros sobre el relieve, densificando para que siga el terreno.
  const drape = (pts: Pt[], closed: boolean, lift: number): [number, number, number][] => {
    const src = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
    const out: [number, number, number][] = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const b = src[Math.min(i + 1, src.length - 1)];
      const steps = i === src.length - 1 ? 1 : Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 80));
      for (let s = 0; s < steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps;
        const y = a.y + ((b.y - a.y) * s) / steps;
        out.push([x * K, scale.toY(scale.groundAt(x, y)) + lift, -y * K]);
      }
    }
    return out;
  };

  /* eslint-disable react-hooks/exhaustive-deps */
  const zoneLine = useMemo(() => (zone ? drape(zone, true, 0.25) : null), [zone, scale, loaded]);
  const pathLine = useMemo(() => (path && path.length > 1 ? drape(path, false, 0.18) : null), [path, scale, loaded]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Vista previa de la zona que se está dibujando, siguiendo al cursor
  let draftLine: [number, number, number][] | null = null;
  if (draft) {
    const pts = hover ? [...draft.pts, hover] : draft.pts;
    if (draft.kind === "poly") {
      if (pts.length > 1) draftLine = drape(pts, pts.length > 2, 0.25);
    } else if (pts.length >= 2) {
      draftLine = drape(shapePolygon(draft.kind, pts.slice(0, 2)), true, 0.25);
    }
  }

  const homeY = scale.toY(scale.groundAt(0, 0));

  return (
    <group>
      {keys.map((k) => {
        const [tx, ty] = k.split("/").map(Number);
        return (
          <Chunk
            key={k}
            world={world}
            tx={tx}
            ty={ty}
            exaggeration={exaggeration}
            layerOpacity={layerOpacity}
            drawing={!!draft}
            onPick={onPick}
            onHover={setHover}
            onLoaded={() => setLoaded((n) => n + 1)}
          />
        );
      })}

      {pathLine && <Line points={pathLine} color="#fbbf24" lineWidth={1.5} transparent opacity={0.9} />}
      {zoneLine && <Line points={zoneLine} color="#ffffff" lineWidth={3} />}
      {draftLine && <Line points={draftLine} color="#ffffff" lineWidth={2} dashed dashSize={0.8} gapSize={0.5} />}
      {draft?.pts.map((p, i) => (
        <mesh key={i} position={[p.x * K, scale.toY(scale.groundAt(p.x, p.y)) + 0.3, -p.y * K]}>
          <sphereGeometry args={[0.45, 16, 12]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      ))}

      {/* base (home): punto de partida del dron */}
      {loaded > 0 && (
        <mesh position={[0, homeY + 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.3, 1.6, 4]} />
          <meshBasicMaterial color="#f8fafc" side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

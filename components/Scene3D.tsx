"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { DroneState } from "../lib/sim";
import World3D, { useScale, type WorldProps } from "./World3D";

const TRAIL_MAX = 800;

// Geometría del cuadricóptero en unidades del modelo (frente = -z)
const DRONE_SCALE = 1.4;
const MOTORS: { x: number; z: number; dir: 1 | -1 }[] = [
  { x: 0.95, z: -0.85, dir: 1 },
  { x: -0.95, z: -0.85, dir: -1 },
  { x: 0.95, z: 0.85, dir: -1 },
  { x: -0.95, z: 0.85, dir: 1 },
];
const SPIN_MAX = 45; // rad/s visuales
const DRONE_Y = 0.48 * DRONE_SCALE; // altura del fuselaje sobre los patines

type Props = WorldProps & {
  follow: boolean;
  /** Se llama una vez por frame con el dt real en segundos. */
  onFrame: (dt: number) => void;
};

function Drone({ world, exaggeration, follow, getState, onFrame }: Pick<Props, "world" | "exaggeration" | "follow" | "getState" | "onFrame">) {
  const scale = useScale(world, exaggeration);
  const framed = useRef(false);
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const tiltRef = useRef<THREE.Group>(null);
  const gimbal = useRef<THREE.Group>(null);
  const strobe = useRef<THREE.Mesh>(null);
  const props = useRef<(THREE.Group | null)[]>([]);
  const discs = useRef<(THREE.Mesh | null)[]>([]);
  const spin = useRef(0);
  const tether = useRef<THREE.Mesh>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const waypoint = useRef<THREE.Group>(null);
  const controls = useRef<OrbitControlsImpl>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  const trail = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
    g.setDrawRange(0, 0);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: "#f8fafc", transparent: true, opacity: 0.6 }));
    line.frustumCulled = false;
    return { line, count: 0, last: new THREE.Vector3(Infinity, 0, 0) };
    // la estela se reinicia al cambiar de terreno
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  useEffect(() => () => {
    trail.line.geometry.dispose();
    (trail.line.material as THREE.Material).dispose();
  }, [trail]);

  useFrame((frame, delta) => {
    onFrame(Math.min(delta, 0.05));
    const s = getState();
    if (!root.current) return;
    root.current.visible = !!s;
    if (!s) return;

    const px = s.x * scale.k;
    const pz = -s.y * scale.k;
    const py = scale.toY(s.alt);
    const gy = scale.toY(scale.groundAt(s.x, s.y));

    body.current!.position.set(px, py + DRONE_Y, pz);
    body.current!.rotation.set(0, -s.yaw, 0);
    // inclinación según la velocidad en ejes del dron
    const fwd = s.vx * Math.sin(s.yaw) + s.vy * Math.cos(s.yaw);
    const right = s.vx * Math.cos(s.yaw) - s.vy * Math.sin(s.yaw);
    const tilt = tiltRef.current!;
    tilt.rotation.x = THREE.MathUtils.lerp(tilt.rotation.x, -fwd * 0.018, 0.1);
    tilt.rotation.z = THREE.MathUtils.lerp(tilt.rotation.z, -right * 0.018, 0.1);
    // el gimbal compensa la inclinación para mantener la cámara nivelada
    gimbal.current!.rotation.set(-tilt.rotation.x, 0, -tilt.rotation.z);

    // las hélices aceleran al armar y con la carga (ascenso/velocidad), y frenan al aterrizar
    const load = Math.min(1, 0.6 + Math.max(s.vz, 0) * 0.05 + Math.hypot(s.vx, s.vy) * 0.01);
    const k = Math.min(1, delta * (s.armed ? 3 : 1.2));
    spin.current += ((s.armed ? SPIN_MAX * load : 0) - spin.current) * k;
    const blur = spin.current / SPIN_MAX;
    MOTORS.forEach((m, i) => {
      const p = props.current[i];
      const d = discs.current[i];
      if (p) p.rotation.y += m.dir * spin.current * delta;
      if (d) (d.material as THREE.MeshBasicMaterial).opacity = blur * 0.22;
    });
    // luz estroboscópica: doble destello por segundo mientras está armado
    const phase = frame.clock.elapsedTime % 1;
    strobe.current!.visible = s.armed && (phase < 0.06 || (phase > 0.16 && phase < 0.22));

    const h = Math.max(py + DRONE_Y - gy, 0.001);
    tether.current!.position.set(px, gy + h / 2, pz);
    tether.current!.scale.y = h;
    shadow.current!.position.set(px, gy + 0.08, pz);

    waypoint.current!.visible = !!s.target;
    if (s.target) {
      waypoint.current!.position.set(
        s.target.x * scale.k,
        scale.toY(scale.groundAt(s.target.x, s.target.y)),
        -s.target.y * scale.k,
      );
    }

    tmp.set(px, py + DRONE_Y, pz);
    if (trail.last.distanceTo(tmp) > 0.25) {
      const attr = trail.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      if (trail.count === TRAIL_MAX) {
        (attr.array as Float32Array).copyWithin(0, 3);
        trail.count--;
      }
      attr.setXYZ(trail.count++, tmp.x, tmp.y, tmp.z);
      attr.needsUpdate = true;
      trail.line.geometry.setDrawRange(0, trail.count);
      trail.last.copy(tmp);
    }

    const c = controls.current;
    // encuadre inicial: en cuanto hay relieve bajo el dron, la cámara se coloca a su lado
    if (c && !framed.current && Number.isFinite(world.ground(s.x, s.y))) {
      framed.current = true;
      c.target.set(px, py, pz);
      c.object.position.set(px + 22, py + 26, pz + 40);
    }
    if (c && follow) {
      tmp.sub(c.target);
      c.object.position.add(tmp);
      c.target.add(tmp);
    }
  });

  return (
    <>
      <OrbitControls ref={controls} makeDefault maxPolarAngle={Math.PI / 2.05} minDistance={8} maxDistance={170} />
      <primitive object={trail.line} />
      <group ref={root}>
        <group ref={body}>
          <group ref={tiltRef} scale={DRONE_SCALE}>
            {/* fuselaje */}
            <mesh rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.55]}>
              <capsuleGeometry args={[0.3, 0.75, 8, 20]} />
              <meshStandardMaterial color="#dfe3e8" roughness={0.35} metalness={0.1} />
            </mesh>
            {/* batería */}
            <mesh position={[0, 0.13, 0.22]}>
              <boxGeometry args={[0.36, 0.12, 0.62]} />
              <meshStandardMaterial color="#2b3038" roughness={0.6} />
            </mesh>
            {/* antena GPS */}
            <mesh position={[0, 0.2, -0.28]}>
              <cylinderGeometry args={[0.1, 0.12, 0.05, 20]} />
              <meshStandardMaterial color="#2b3038" roughness={0.5} />
            </mesh>

            {MOTORS.map((m, i) => {
              const len = Math.hypot(m.x, m.z);
              const front = m.z < 0;
              return (
                <group key={i}>
                  {/* brazo */}
                  <mesh position={[m.x / 2, 0, m.z / 2]} rotation={[0, Math.atan2(-m.z, m.x), 0]}>
                    <boxGeometry args={[len, 0.07, 0.1]} />
                    <meshStandardMaterial color="#c3c9d1" roughness={0.45} />
                  </mesh>
                  {/* motor */}
                  <mesh position={[m.x, 0.07, m.z]}>
                    <cylinderGeometry args={[0.11, 0.12, 0.2, 20]} />
                    <meshStandardMaterial color="#1f232a" roughness={0.4} metalness={0.6} />
                  </mesh>
                  {/* hélice bipala + disco de desenfoque */}
                  <group ref={(el) => { props.current[i] = el; }} position={[m.x, 0.19, m.z]}>
                    <mesh>
                      <boxGeometry args={[1.0, 0.012, 0.085]} />
                      <meshStandardMaterial color="#14171c" roughness={0.5} />
                    </mesh>
                    <mesh>
                      <cylinderGeometry args={[0.045, 0.045, 0.05, 12]} />
                      <meshStandardMaterial color="#9aa3ad" metalness={0.7} roughness={0.3} />
                    </mesh>
                  </group>
                  <mesh
                    ref={(el) => { discs.current[i] = el; }}
                    position={[m.x, 0.195, m.z]}
                    rotation={[-Math.PI / 2, 0, 0]}
                  >
                    <circleGeometry args={[0.5, 32]} />
                    <meshBasicMaterial color="#cbd5e1" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
                  </mesh>
                  {/* luces de navegación: rojo delante, verde detrás */}
                  <mesh position={[m.x, -0.06, m.z]}>
                    <sphereGeometry args={[0.055, 12, 12]} />
                    <meshBasicMaterial color={front ? "#ff3b30" : "#34d058"} />
                  </mesh>
                </group>
              );
            })}

            {/* tren de aterrizaje */}
            {[-1, 1].map((side) => (
              <group key={side}>
                {[-0.3, 0.3].map((z) => (
                  <mesh key={z} position={[side * 0.3, -0.27, z]} rotation={[0, 0, side * 0.35]}>
                    <cylinderGeometry args={[0.022, 0.022, 0.4, 8]} />
                    <meshStandardMaterial color="#2b3038" />
                  </mesh>
                ))}
                <mesh position={[side * 0.37, -0.45, 0]} rotation={[Math.PI / 2, 0, 0]}>
                  <capsuleGeometry args={[0.028, 0.95, 4, 8]} />
                  <meshStandardMaterial color="#2b3038" />
                </mesh>
              </group>
            ))}

            {/* cámara con gimbal bajo el morro */}
            <group position={[0, -0.24, -0.4]}>
              <mesh position={[0, 0.07, 0]}>
                <cylinderGeometry args={[0.035, 0.035, 0.1, 8]} />
                <meshStandardMaterial color="#2b3038" />
              </mesh>
              <group ref={gimbal}>
                <mesh>
                  <sphereGeometry args={[0.12, 20, 16]} />
                  <meshStandardMaterial color="#1f232a" roughness={0.3} metalness={0.4} />
                </mesh>
                <mesh position={[0, 0, -0.11]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[0.06, 0.06, 0.05, 20]} />
                  <meshStandardMaterial color="#0b0d10" roughness={0.1} metalness={0.9} />
                </mesh>
              </group>
            </group>

            {/* estroboscópica de cola */}
            <mesh ref={strobe} position={[0, 0.05, 0.68]} visible={false}>
              <sphereGeometry args={[0.07, 12, 12]} />
              <meshBasicMaterial color="#ffffff" />
            </mesh>
          </group>
        </group>
        <mesh ref={tether}>
          <cylinderGeometry args={[0.03, 0.03, 1, 6]} />
          <meshBasicMaterial color="#f8fafc" transparent opacity={0.45} />
        </mesh>
        <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.5, 0.7, 32]} />
          <meshBasicMaterial color="#f8fafc" transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>
        <group ref={waypoint} visible={false}>
          <mesh position={[0, 1.6, 0]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.7, 2.4, 4]} />
            <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.5} />
          </mesh>
        </group>
      </group>
    </>
  );
}

export default function Scene3D(props: Props) {
  return (
    <Canvas className="sky" camera={{ position: [22, 60, 40], fov: 45, near: 0.5, far: 1500 }} dpr={[1, 2]}>
      {/* la bruma disimula el borde del terreno cargado */}
      <fog attach="fog" args={["#4d6984", 110, 330]} />
      <ambientLight intensity={1.7} />
      <directionalLight position={[-60, 90, 40]} intensity={1.6} />
      <World3D
        world={props.world}
        exaggeration={props.exaggeration}
        layerOpacity={props.layerOpacity}
        zone={props.zone}
        path={props.path}
        draft={props.draft}
        getState={props.getState}
        onPick={props.onPick}
      />
      {/* la clave reinicia cámara y estela al cambiar de lugar */}
      <Drone key={`${props.world.origin.lat},${props.world.origin.lon}`} {...props} />
    </Canvas>
  );
}

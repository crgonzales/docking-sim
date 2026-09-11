import { Component, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Group,
} from 'three';
import type { FlightSession } from './flightSession';
import type { FlightCloudLightingBridge } from '../scene/flightCloudLighting';
import { cloneHornet, resolveHornetAnisotropy, type ClonedHornet } from './hornetMaterials';

const HORNET_MODEL_URL = '/assets/models/f18/hornet-source.glb';

/** Source +X is LEFT, +Y is UP and +Z is FORWARD; output is body FRD. */
const SOURCE_TO_BODY = new Matrix4().set(
  0, 0, 1, 0,
  -1, 0, 0, 0,
  0, -1, 0, 0,
  0, 0, 0, 1,
);
const SOURCE_LENGTH_M = 16.9529317;
const HORNET_LENGTH_M = 17.06;
const HORNET_SCALE = HORNET_LENGTH_M / SOURCE_LENGTH_M;
const SOURCE_CENTER_X = (-5.991190 + 5.991191) * 0.5;
const SOURCE_CENTER_Z = (-8.509572 + 8.443360) * 0.5;
const BODY_PIVOT = new Vector3(-SOURCE_CENTER_Z * HORNET_SCALE, SOURCE_CENTER_X * HORNET_SCALE, 0);
const SOURCE_TO_BODY_ROTATION = new Quaternion().setFromRotationMatrix(SOURCE_TO_BODY);

/** Original low-poly Hornet-style silhouette in body FRD, metres. */
function Panel({ points, color = '#929fa9' }: { points: number[][]; color?: string }) {
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    const vertices: number[] = [];
    for (let i = 1; i < points.length - 1; i++) vertices.push(...points[0], ...points[i], ...points[i + 1]);
    g.setAttribute('position', new Float32BufferAttribute(vertices, 3)); g.computeVertexNormals();
    return g;
  }, [points]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} castShadow receiveShadow><meshStandardMaterial color={color} side={DoubleSide} metalness={0.25} roughness={0.6} /></mesh>;
}

const ProceduralHornetModel = memo(function ProceduralHornetModel({ session, parked, cloudLighting }: {
  session: FlightSession; parked: boolean; cloudLighting?: FlightCloudLightingBridge;
}) {
  const root = useRef<Group>(null);
  const tail = useRef<Group>(null);
  const leftAileron = useRef<Group>(null), rightAileron = useRef<Group>(null);
  useLayoutEffect(() => {
    if (!cloudLighting || !root.current) return undefined;
    const releases: (() => void)[] = [];
    root.current.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (material instanceof MeshStandardMaterial) releases.push(cloudLighting.registerMaterial(material));
      });
    });
    return () => releases.forEach((release) => release());
  }, [cloudLighting]);
  useFrame(() => {
    if (tail.current) tail.current.rotation.y = -0.25 * session.controls.pitch - 0.12 * session.controls.trim;
    if (leftAileron.current) leftAileron.current.rotation.y = 0.25 * session.controls.roll;
    if (rightAileron.current) rightAileron.current.rotation.y = -0.25 * session.controls.roll;
  });
  const body = useMemo(() => {
    const rings = [[-8.2, 0.75, 0.6], [-5, 1.35, 0.75], [0, 1.25, 0.8], [4.3, 0.7, 0.65], [6, 0.5, 0.48], [8.6, 0.02, 0.02]];
    const vertices: number[] = [], indices: number[] = [], segments = 12;
    rings.forEach(([x, width, height]) => { for (let j = 0; j < segments; j++) { const a = 2 * Math.PI * j / segments; vertices.push(x, width * Math.cos(a), height * Math.sin(a)); } });
    for (let r = 0; r < rings.length - 1; r++) for (let j = 0; j < segments; j++) {
      const a = r * segments + j, b = r * segments + (j + 1) % segments, c = a + segments, d = b + segments;
      indices.push(a, b, c, b, d, c);
    }
    const g = new BufferGeometry(); g.setAttribute('position', new Float32BufferAttribute(vertices, 3)); g.setIndex(indices); g.computeVertexNormals(); return g;
  }, []);
  useEffect(() => () => body.dispose(), [body]);
  return <group ref={root}>
    {parked && [[-1.5, -1.5], [-1.5, 1.5], [5.5, 0]].map(([x, y]) => <group key={`${x}/${y}`}>
      <mesh position={[x, y, 1.4]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.08, 0.08, 1.2, 8]} /><meshStandardMaterial color="#aab4bc" />
      </mesh>
      <mesh position={[x, y, 2]} castShadow receiveShadow>
        <cylinderGeometry args={[0.4, 0.4, 0.22, 12]} /><meshStandardMaterial color="#20272c" />
      </mesh>
    </group>)}
    <mesh geometry={body} castShadow receiveShadow><meshStandardMaterial color="#aab4bc" metalness={0.35} roughness={0.57} side={DoubleSide} /></mesh>
    <mesh position={[4.2, 0, -0.74]} scale={[2.2, 0.65, 0.74]} receiveShadow>
      <sphereGeometry args={[1, 24, 12]} /><meshStandardMaterial color="#193943" metalness={0.7} roughness={0.18} />
    </mesh>
    <mesh position={[6.4, 0, 0]} rotation={[0, 0, -Math.PI / 2]} castShadow receiveShadow>
      <coneGeometry args={[0.5, 3.8, 16]} /><meshStandardMaterial color="#535d66" />
    </mesh>
    {[-1, 1].map((side) => <group key={side}>
      <Panel points={[[2, side * 1.1, -0.1], [-1.5, side * 6.15, 0], [-3.3, side * 6.15, 0], [-4, side * 1.1, -0.1]]} />
      <Panel points={[[5.5, side * 0.65, -0.3], [1.7, side * 2.3, -0.2], [-1, side * 1.3, -0.15]]} color="#b3bec5" />
      <Panel points={[[-3.7, side * 1.3, -0.5], [-5.6, side * 2.45, -3.65], [-7.2, side * 2.75, -3.65], [-7.8, side * 1.3, -0.5]]} color="#7c8a95" />
      <mesh position={[-4.4, side * 0.8, 0.45]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
        <cylinderGeometry args={[0.6, 0.67, 7.5, 16]} /><meshStandardMaterial color="#71818d" roughness={0.65} />
      </mesh>
      <mesh position={[-8.3, side * 0.8, 0.45]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
        <cylinderGeometry args={[0.52, 0.6, 0.7, 16, 1, true]} /><meshStandardMaterial color="#263239" side={DoubleSide} metalness={0.8} roughness={0.45} />
      </mesh>
      <mesh position={[-8.5, side * 0.8, 0.45]} rotation={[0, Math.PI / 2, 0]}>
        <circleGeometry args={[0.49, 16]} /><meshBasicMaterial color="#e89856" side={DoubleSide} />
      </mesh>
      <mesh position={[1, side * 1.1, 0.4]} scale={[1.3, 0.4, 0.48]} castShadow receiveShadow>
        <boxGeometry /><meshStandardMaterial color="#28343c" />
      </mesh>
      <mesh position={[-2, side * 6.15, 0]}><sphereGeometry args={[0.09, 8, 6]} /><meshBasicMaterial color={side < 0 ? '#ff5151' : '#75ffa0'} /></mesh>
      <group ref={side < 0 ? leftAileron : rightAileron} position={[-3.25, side * 4.45, 0]}>
        <Panel points={[[0, -1.5, 0], [0, 1.5, 0], [-0.55, 1.5, 0], [-0.55, -1.5, 0]]} color="#6f7d87" />
      </group>
    </group>)}
    <group ref={tail} position={[-6.6, 0, 0]}>
      {[-1, 1].map((side) => <Panel key={side} points={[[1.7, side * 1, 0], [0.3, side * 3.8, 0.05], [-1.7, side * 3.8, 0.05], [-1.4, side * 1, 0]]} />)}
    </group>
  </group>;
});

class HornetModelErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn('F/A-18C model failed to load; using procedural fallback.', error); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const GltfHornetModel = memo(function GltfHornetModel({ parked, anisotropy, cloudLighting }: {
  parked: boolean; anisotropy: number; cloudLighting?: FlightCloudLightingBridge;
}) {
  const { scene } = useGLTF(HORNET_MODEL_URL);
  const root = useRef<Group>(null);
  const owned = useRef<ClonedHornet | null>(null);
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const resolvedAnisotropy = resolveHornetAnisotropy(anisotropy, gl.capabilities.getMaxAnisotropy());
  const transform = useMemo(() => new Matrix4().compose(
    BODY_PIVOT,
    SOURCE_TO_BODY_ROTATION,
    new Vector3(HORNET_SCALE, HORNET_SCALE, HORNET_SCALE),
  ), []);
  // Allocate owned materials/textures in committed setup, including StrictMode replay.
  // Rebasing/daylight do not clone or dispose them; cached source assets survive.
  useLayoutEffect(() => {
    const cloned = cloneHornet(scene as Group, parked, cloudLighting);
    owned.current = cloned;
    const parent = root.current!;
    parent.add(cloned.model);
    invalidate();
    return () => {
      parent.remove(cloned.model);
      owned.current = null;
      cloned.dispose();
    };
  }, [cloudLighting, scene, parked, invalidate]);
  useLayoutEffect(() => {
    owned.current?.textures.forEach((texture) => {
      if (texture.anisotropy === resolvedAnisotropy) return;
      texture.anisotropy = resolvedAnisotropy;
      texture.needsUpdate = true;
    });
    invalidate();
  }, [scene, parked, resolvedAnisotropy, invalidate]);
  return <group ref={root} matrix={transform} matrixAutoUpdate={false} dispose={null} />;
});

// drei's cache retains the source hierarchy, geometry and textures across
// FLIGHT unmount/reentry. Each mounted adapter still receives its own clone.
useGLTF.preload(HORNET_MODEL_URL);

export const HornetModel = memo(function HornetModel({ session, parked = false, anisotropy = 8, cloudLighting }: {
  session: FlightSession; parked?: boolean; anisotropy?: number; cloudLighting?: FlightCloudLightingBridge;
}) {
  const fallback = <ProceduralHornetModel session={session} parked={parked} cloudLighting={cloudLighting} />;
  return (
    <HornetModelErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <GltfHornetModel parked={parked} anisotropy={anisotropy} cloudLighting={cloudLighting} />
      </Suspense>
    </HornetModelErrorBoundary>
  );
});

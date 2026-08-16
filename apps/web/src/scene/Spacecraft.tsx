import { Component, Suspense, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import {
  CylinderGeometry,
  Group,
  Matrix4,
  MathUtils,
  Quaternion,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Mesh,
  type MeshStandardMaterial,
} from 'three';
import { conjugateQuaternion } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { ThrusterPlumes } from './ThrusterPlumes';
import {
  computeModelNormalizationTransform,
  maxAbsComponent,
  CHASER_MODEL_NORMALIZATION,
  CHASER_PORT_BODY,
  STATION_PORT_HILL,
  TARGET_MODEL_NORMALIZATION,
  type ModelNormalization,
  type ModelVec3,
} from './modelNormalization';
export { CHASER_PORT_BODY, STATION_PORT_HILL } from './modelNormalization';

/**
 * Target station (origin) and chaser (bus-driven) in the Hill frame:
 * x̂ radial out, ŷ along-track, ẑ = x̂ × ŷ. The chaser approaches on −ŷ;
 * the station's docking port faces −ŷ, the chaser's docking axis is +ŷ.
 *
 * The normalized glTF path is implemented but remains opt-in until the
 * LUCKY MARLIN livery has been visually confirmed on the real model. The
 * Suspense + error-boundary path keeps the scene alive if a model fails to
 * load (Suspense covers loading only, never errors, hence the explicit
 * boundary).
 */
const USE_GLTF_MODELS = false;
const TARGET_MODEL_URL = '/assets/models/target.glb';
const CHASER_MODEL_URL = '/assets/models/chaser.glb';

/** Render-rate smoothing constant for the 10 Hz bus position (1/s). */
const POSITION_DAMP_LAMBDA = 1.5;

interface CraftErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

class CraftErrorBoundary extends Component<CraftErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn('Spacecraft model failed to load; using primitive fallback.', error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Stylized modular station: hub, truss, panels, −ŷ docking port. */
function PrimitiveStation() {
  return (
    <group>
      <mesh>
        <cylinderGeometry args={[2.2, 2.2, 14, 24]} />
        <meshStandardMaterial color="#b8bcc4" metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh>
        <boxGeometry args={[1.2, 1.2, 44]} />
        <meshStandardMaterial color="#8b8f99" metalness={0.7} roughness={0.4} />
      </mesh>
      {[-16, 16].map((z) => (
        <mesh key={z} position={[0, 0, z]}>
          <boxGeometry args={[0.15, 10, 24]} />
          <meshStandardMaterial color="#1a2b5e" metalness={0.3} roughness={0.55} />
        </mesh>
      ))}
      <mesh position={[0, -7.8, 0]}>
        <cylinderGeometry args={[1.0, 1.4, 1.6, 16]} />
        <meshStandardMaterial color="#6f7480" metalness={0.8} roughness={0.3} />
      </mesh>
      <DockingTarget />
    </group>
  );
}

function DockingTarget() {
  return (
    <group position={STATION_PORT_HILL} rotation={[Math.PI / 2, 0, 0]}>
      <mesh>
        <ringGeometry args={[0.65, 0.85, 24]} />
        <meshStandardMaterial color="#f0b429" emissive="#f0b429" emissiveIntensity={1.5} />
      </mesh>
      <mesh position={[0, 0, 0.03]}>
        <boxGeometry args={[0.12, 1.35, 0.04]} />
        <meshStandardMaterial color="#fff3bd" emissive="#f0b429" emissiveIntensity={2} />
      </mesh>
      <mesh position={[0, 0, 0.04]} rotation={[0, 0, Math.PI / 2]}>
        <boxGeometry args={[0.12, 1.35, 0.04]} />
        <meshStandardMaterial color="#fff3bd" emissive="#f0b429" emissiveIntensity={2} />
      </mesh>
    </group>
  );
}

interface ChaserLiveryProps {
  gltf?: boolean;
}

function ChaserLivery({ gltf = false }: ChaserLiveryProps) {
  const { gl: renderer } = useThree();
  const logoTexture = useLoader(TextureLoader, '/assets/textures/lucky_marlin_logo.png');
  logoTexture.colorSpace = SRGBColorSpace;
  logoTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const logoPatchGeometry = useMemo(() => new CylinderGeometry(
    gltf ? 1.292 : 1.912,
    gltf ? 1.292 : 1.912,
    gltf ? 0.52 : 1.34,
    20,
    1,
    true,
    -0.7,
    1.4,
  ), [gltf]);

  return (
    <mesh
      geometry={logoPatchGeometry}
      position={[0, gltf ? 1.0 : -2.4, 0]}
      renderOrder={1}
    >
      <meshStandardMaterial
        map={logoTexture}
        transparent
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-1}
        roughness={0.52}
        metalness={0.18}
      />
    </mesh>
  );
}

/** Stylized capsule chaser, docking axis +ŷ. */
function PrimitiveChaser() {
  return (
    <group>
      <mesh>
        <cylinderGeometry args={[1.1, 1.9, 3.4, 20]} />
        <meshStandardMaterial color="#d8d3c8" metalness={0.45} roughness={0.5} />
      </mesh>
      <mesh position={[0, -2.4, 0]}>
        <cylinderGeometry args={[1.9, 1.9, 1.4, 20]} />
        <meshStandardMaterial color="#7a7e88" metalness={0.7} roughness={0.35} />
      </mesh>
      <ChaserLivery />
      {[-1, 1].map((s) => (
        <mesh key={s} position={[2.6 * s, -2.4, 0]}>
          <boxGeometry args={[3.4, 0.08, 1.5]} />
          <meshStandardMaterial color="#1a2b5e" metalness={0.3} roughness={0.55} />
        </mesh>
      ))}
    </group>
  );
}

interface GltfModelProps {
  url: string;
  normalization: ModelNormalization;
}

function resolvePortLocal(model: Group, normalization: ModelNormalization): ModelVec3 {
  if (normalization.portLocal !== undefined) return normalization.portLocal;
  const portNode = model.getObjectByName(normalization.portNodeName);
  if (portNode === undefined) {
    throw new Error(`Normalized model is missing port node "${normalization.portNodeName}"`);
  }
  model.updateMatrixWorld(true);
  const portWorld = portNode.getWorldPosition(new Vector3());
  const modelInverse = new Matrix4().copy(model.matrixWorld).invert();
  portWorld.applyMatrix4(modelInverse);
  return [portWorld.x, portWorld.y, portWorld.z];
}

function GltfModel({ url, normalization }: GltfModelProps) {
  const { scene } = useGLTF(url);
  const normalizedScene = useMemo(() => {
    const model = scene.clone(true) as Group;
    // glTF exporters default metallicFactor to 1; with no environment map a
    // fully-metallic PBR surface reflects nothing and renders black under the
    // scene's single directional light. Cap metalness so the hull shades like
    // painted aluminum instead of unlit vantablack.
    model.traverse((child) => {
      const material = (child as Mesh).material as MeshStandardMaterial | undefined;
      if (material?.isMeshStandardMaterial === true && material.metalness > 0.4) {
        material.metalness = 0.35;
        material.roughness = Math.max(material.roughness, 0.45);
      }
    });
    const portLocal = resolvePortLocal(model, normalization);
    const transform = computeModelNormalizationTransform(normalization, portLocal);
    if (maxAbsComponent(transform.portError) > 0.01) {
      throw new Error(`Model port registration exceeds 0.01 m: ${transform.portError.join(', ')}`);
    }
    model.scale.setScalar(transform.scale);
    model.rotation.set(...transform.rotation);
    model.position.set(...transform.position);
    return model;
  }, [normalization, scene]);
  return <primitive object={normalizedScene} dispose={null} />;
}

if (USE_GLTF_MODELS) {
  useGLTF.preload(TARGET_MODEL_URL);
  useGLTF.preload(CHASER_MODEL_URL);
}

function Chaser() {
  const ref = useRef<Group>(null);
  const targetQuaternion = useRef(new Quaternion());
  const renderState = useTelemetryBus((state) => state.renderState);

  useFrame((_, dt) => {
    const group = ref.current;
    if (!group || !renderState) return;
    const [x, y, z] = renderState.r_hill_m;
    group.position.x = MathUtils.damp(group.position.x, x, POSITION_DAMP_LAMBDA, dt);
    group.position.y = MathUtils.damp(group.position.y, y, POSITION_DAMP_LAMBDA, dt);
    group.position.z = MathUtils.damp(group.position.z, z, POSITION_DAMP_LAMBDA, dt);
    const q_HB = conjugateQuaternion(renderState.q_BH);
    targetQuaternion.current.set(q_HB[1], q_HB[2], q_HB[3], q_HB[0]);
    group.quaternion.slerp(targetQuaternion.current, 1 - Math.exp(-4 * dt));
  });

  return (
    <group ref={ref} position={[0, -250, 12]}>
      <ThrusterPlumes />
      {USE_GLTF_MODELS ? (
        <CraftErrorBoundary fallback={<PrimitiveChaser />}>
          <Suspense fallback={null}>
            <GltfModel url={CHASER_MODEL_URL} normalization={CHASER_MODEL_NORMALIZATION} />
            <ChaserLivery gltf />
          </Suspense>
        </CraftErrorBoundary>
      ) : (
        <PrimitiveChaser />
      )}
    </group>
  );
}

export function Spacecraft() {
  return (
    <>
      <group>
        {USE_GLTF_MODELS ? (
          <CraftErrorBoundary fallback={<PrimitiveStation />}>
            <Suspense fallback={null}>
              <GltfModel url={TARGET_MODEL_URL} normalization={TARGET_MODEL_NORMALIZATION} />
            </Suspense>
          </CraftErrorBoundary>
        ) : (
          <PrimitiveStation />
        )}
      </group>
      <Chaser />
    </>
  );
}

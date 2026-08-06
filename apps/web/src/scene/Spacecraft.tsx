import { Component, Suspense, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Group, MathUtils } from 'three';
import { getLatestFrame } from '../telemetry/bus';

/**
 * Target station (origin) and chaser (bus-driven) in the Hill frame:
 * x̂ radial out, ŷ along-track, ẑ = x̂ × ŷ. The chaser approaches on −ŷ;
 * the station's docking port faces −ŷ, the chaser's docking axis is +ŷ.
 *
 * Phase 1 ships stylized primitive craft (see public/assets/ASSETS.md).
 * Flip USE_GLTF_MODELS once normalized target.glb / chaser.glb land in
 * /assets/models — the Suspense + error-boundary path below keeps the
 * scene alive if a model fails to load (Suspense covers loading only,
 * never errors, hence the explicit boundary).
 */
const USE_GLTF_MODELS = false;
const TARGET_MODEL_URL = '/assets/models/target.glb';
const CHASER_MODEL_URL = '/assets/models/chaser.glb';
/**
 * Render-rate smoothing constant for the 10 Hz bus position (1/s).
 * Deliberately low-bandwidth: the bus carries the noisy NAV estimate (the
 * only position signal in Phase 1), and a fast lambda visibly tracks the
 * noise at close range. λ=1.5 (τ≈0.67 s) filters the jitter; the resulting
 * ~0.5 m trailing lag at 0.85 m/s closing is imperceptible.
 */
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
      {/* pressurized hub along y (cylinder's native axis) */}
      <mesh>
        <cylinderGeometry args={[2.2, 2.2, 14, 24]} />
        <meshStandardMaterial color="#b8bcc4" metalness={0.6} roughness={0.35} />
      </mesh>
      {/* truss along z */}
      <mesh>
        <boxGeometry args={[1.2, 1.2, 44]} />
        <meshStandardMaterial color="#8b8f99" metalness={0.7} roughness={0.4} />
      </mesh>
      {/* solar arrays */}
      {[-16, 16].map((z) => (
        <mesh key={z} position={[0, 0, z]}>
          <boxGeometry args={[0.15, 10, 24]} />
          <meshStandardMaterial color="#1a2b5e" metalness={0.3} roughness={0.55} />
        </mesh>
      ))}
      {/* docking port facing the approaching chaser (−ŷ, cylinder native axis) */}
      <mesh position={[0, -7.8, 0]}>
        <cylinderGeometry args={[1.0, 1.4, 1.6, 16]} />
        <meshStandardMaterial color="#6f7480" metalness={0.8} roughness={0.3} />
      </mesh>
    </group>
  );
}

/** Stylized capsule chaser, docking axis +ŷ. */
function PrimitiveChaser() {
  return (
    <group>
      {/* blunt cone: narrow top (docking end) toward +y, cylinder native axis */}
      <mesh>
        <cylinderGeometry args={[1.1, 1.9, 3.4, 20]} />
        <meshStandardMaterial color="#d8d3c8" metalness={0.45} roughness={0.5} />
      </mesh>
      <mesh position={[0, -2.4, 0]}>
        <cylinderGeometry args={[1.9, 1.9, 1.4, 20]} />
        <meshStandardMaterial color="#7a7e88" metalness={0.7} roughness={0.35} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[2.6 * s, -2.4, 0]}>
          <boxGeometry args={[3.4, 0.08, 1.5]} />
          <meshStandardMaterial color="#1a2b5e" metalness={0.3} roughness={0.55} />
        </mesh>
      ))}
    </group>
  );
}

function GltfModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return <primitive object={scene} />;
}

if (USE_GLTF_MODELS) {
  useGLTF.preload(TARGET_MODEL_URL);
  useGLTF.preload(CHASER_MODEL_URL);
}

function Chaser() {
  const ref = useRef<Group>(null);

  useFrame((_, dt) => {
    const group = ref.current;
    const frame = getLatestFrame();
    if (!group || !frame) return;
    // The 10 Hz bus frame is the authoritative target; damp at render rate
    // so approach motion neither steps nor amplifies the seeded nav noise.
    const [x, y, z] = frame.nav_r_hill_m;
    group.position.x = MathUtils.damp(group.position.x, x, POSITION_DAMP_LAMBDA, dt);
    group.position.y = MathUtils.damp(group.position.y, y, POSITION_DAMP_LAMBDA, dt);
    group.position.z = MathUtils.damp(group.position.z, z, POSITION_DAMP_LAMBDA, dt);
  });

  return (
    <group ref={ref} position={[0, -250, 12]}>
      {USE_GLTF_MODELS ? (
        <CraftErrorBoundary fallback={<PrimitiveChaser />}>
          <Suspense fallback={null}>
            <GltfModel url={CHASER_MODEL_URL} />
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
              <GltfModel url={TARGET_MODEL_URL} />
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

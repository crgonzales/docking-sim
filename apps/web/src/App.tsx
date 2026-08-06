import { Canvas, useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Mesh } from 'three';
import { TRUTH_HZ } from '@docking/sim-core';

/**
 * Placeholder shell. Phase 1 replaces this with the real scene:
 * Earth + starfield, glTF spacecraft, HUD, docking camera PiP.
 */
function TargetPlaceholder() {
  const ref = useRef<Mesh>(null);
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.y += dt * 0.15; });
  return (
    <mesh ref={ref}>
      <icosahedronGeometry args={[1, 1]} />
      <meshBasicMaterial wireframe color="#3aa76d" />
    </mesh>
  );
}

export function App() {
  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <Canvas camera={{ position: [0, 0, 4], fov: 50 }}>
        <TargetPlaceholder />
      </Canvas>
      <div style={{
        position: 'absolute', top: 12, left: 12, color: '#3aa76d',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
      }}>
        SIM-CORE LINKED &middot; TRUTH {TRUTH_HZ} HZ &middot; PHASE 1 PENDING
      </div>
    </div>
  );
}

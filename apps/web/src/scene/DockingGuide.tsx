import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { useAppModeStore } from '../appModeStore';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { useTelemetryBus } from '../telemetry/bus';
import { STATION_PORT_HILL } from './modelNormalization';
import type { WorldFrame } from './worldFrame';

/** Teaching markers anchored to the real station port; never part of contact physics. */
export function DockingGuide({ worldFrame }: { worldFrame: WorldFrame }) {
  const root = useRef<Group>(null);
  useFrame(() => {
    if (!root.current) return;
    const lesson = useScenarioStore.getState();
    root.current.visible = useAppModeStore.getState().mode === 'MISSION'
      && lesson.selectedMission === 'FIRST_DOCKING' && lesson.phase === 'RUNNING';
    root.current.position.set(...worldFrame.toRender(STATION_PORT_HILL));
    const frame = useTelemetryBus.getState().frame;
    for (const child of root.current.children) {
      // Retire the passed approach rings so they do not obscure the capsule.
      child.visible = child.position.y === -0.04 || !frame || frame.nav_r_hill_m[1] < STATION_PORT_HILL[1] + child.position.y;
    }
  });
  return <group ref={root} visible={false}>
    <mesh position={[0, -0.04, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[0.96, 0.018, 5, 48]} /><meshBasicMaterial color="#73efc4" transparent opacity={0.8} depthWrite={false} toneMapped={false} />
    </mesh>
    {[2, 4, 6].map(gap => <mesh key={gap} position={[0, -gap, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[1.15, 0.01, 4, 48]} /><meshBasicMaterial color="#73bfd6" transparent opacity={0.24} depthWrite={false} toneMapped={false} />
    </mesh>)}
  </group>;
}

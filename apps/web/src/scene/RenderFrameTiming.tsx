import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { renderTimings } from './renderTimings';

/** Mounted only in the profiled flight scene, whose composer already owns
 * rendering at priority 1. Observe its callbacks through R3F's public API. */
export function RenderFrameTiming() {
  const startedAt = useRef(-1);
  useFrame(() => { startedAt.current = renderTimings.start('frame.callbacksCpuWall'); }, -1000);
  useFrame(() => {
    renderTimings.end('frame.callbacksCpuWall', startedAt.current);
    startedAt.current = -1;
  }, 4); // After main composer (1), PiP (2), and probe (3).
  return null;
}

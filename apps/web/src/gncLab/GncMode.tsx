import { useEffect } from 'react';
import { SceneRoot } from '../scene/SceneRoot';
import { startGncSession, stopGncSession } from '../telemetry/gncEmitter';
import { GncLab } from './ui/GncLab';

/** Lazy mode boundary owns the publisher; the lab is a subscriber overlay. */
export function GncMode() {
  useEffect(() => {
    startGncSession();
    return stopGncSession;
  }, []);

  return <div style={{ height: '100%', position: 'relative' }}>
    <SceneRoot />
    <GncLab />
  </div>;
}

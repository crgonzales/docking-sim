import { useEffect } from 'react';
import { Hud } from './hud/Hud';
import { SceneRoot } from './scene/SceneRoot';
import { startSimEmitter, stopSimEmitter } from './telemetry/simEmitter';

export function App() {
  useEffect(() => {
    startSimEmitter();
    return stopSimEmitter;
  }, []);

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <SceneRoot />
      <Hud />
    </div>
  );
}

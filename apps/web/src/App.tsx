import { useEffect } from 'react';
import { Hud } from './hud/Hud';
import { SceneRoot } from './scene/SceneRoot';
import { startStubEmitter, stopStubEmitter } from './telemetry/stubEmitter';

export function App() {
  useEffect(() => {
    startStubEmitter();
    return stopStubEmitter;
  }, []);

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <SceneRoot />
      <Hud />
    </div>
  );
}

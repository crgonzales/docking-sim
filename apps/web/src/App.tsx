import { useEffect, useRef } from 'react';
import { Hud } from './hud/Hud';
import { attachManualControls } from './input/manualControls';
import { SceneRoot } from './scene/SceneRoot';
import { DockingCameraPiP } from './scene/DockingCameraPiP';
import { startSimEmitter, stopSimEmitter } from './telemetry/simEmitter';

export function App() {
  const inputElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startSimEmitter();
    const detach = inputElement.current === null ? undefined : attachManualControls(inputElement.current);
    return () => {
      detach?.();
      stopSimEmitter();
    };
  }, []);

  return (
    <div ref={inputElement} style={{ height: '100%', position: 'relative' }}>
      <SceneRoot />
      <Hud />
      <DockingCameraPiP />
    </div>
  );
}

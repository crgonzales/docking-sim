import { useEffect, useRef } from 'react';
import { useAppModeStore } from './appModeStore';
import { MonteCarloScreen } from './analysis/MonteCarloScreen';
import { Hud } from './hud/Hud';
import { ModeSwitcher } from './hud/ModeSwitcher';
import { attachManualControls } from './input/manualControls';
import { SceneRoot } from './scene/SceneRoot';
import { DockingCameraPiP } from './scene/DockingCameraPiP';
import { useFlightAudio } from './hud/flightAudio';
import { startSimEmitter, stopSimEmitter } from './telemetry/simEmitter';
import { startScenario, stopScenario } from './telemetry/scenarioEmitter';

export function App() {
  const inputElement = useRef<HTMLDivElement>(null);
  const mode = useAppModeStore((state) => state.mode);
  useFlightAudio(mode);

  useEffect(() => {
    if (mode === 'SANDBOX') startSimEmitter();
    if (mode === 'MISSION') startScenario();
    const detach = mode === 'ANALYSIS' || inputElement.current === null
      ? undefined
      : attachManualControls(inputElement.current);
    return () => {
      detach?.();
      if (mode === 'SANDBOX') stopSimEmitter();
      if (mode === 'MISSION') stopScenario();
    };
  }, [mode]);

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      {mode === 'ANALYSIS' ? <MonteCarloScreen /> : (
        <div ref={inputElement} style={{ height: '100%', position: 'relative' }}>
          <SceneRoot />
          <Hud />
          <DockingCameraPiP />
        </div>
      )}
      <ModeSwitcher />
    </div>
  );
}

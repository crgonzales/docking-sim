import { lazy, Suspense, useEffect, useRef } from 'react';
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

const FlightMode = lazy(() => import('./flight/FlightMode').then((module) => ({ default: module.FlightMode })));
const GncMode = lazy(() => import('./gncLab/GncMode').then((module) => ({ default: module.GncMode })));

export function App() {
  const inputElement = useRef<HTMLDivElement>(null);
  const mode = useAppModeStore((state) => state.mode);
  useFlightAudio(mode);

  useEffect(() => {
    if (mode === 'SANDBOX') startSimEmitter();
    if (mode === 'MISSION') startScenario();
    const detach = (mode !== 'SANDBOX' && mode !== 'MISSION') || inputElement.current === null
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
      {mode === 'GNC' ? <Suspense fallback={<p role="status" style={{ color: 'white' }}>Loading GNC…</p>}><GncMode /></Suspense>
        : mode === 'FLIGHT' ? <Suspense fallback={<p style={{ color: 'white' }}>Loading flight…</p>}><FlightMode /></Suspense> : mode === 'ANALYSIS' ? <MonteCarloScreen /> : (
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

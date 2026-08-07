import { useScenarioStore } from '../telemetry/scenarioStore';

function formatRemaining(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.ceil(seconds));
  return `T-${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

export function MissionClock() {
  const state = useScenarioStore((store) => store.state);
  if (state?.phase !== 'RUNNING') return null;

  return (
    <div className={`mission-clock ${state.clock.remaining_s < 60 ? 'urgent' : ''}`}>
      <div className="mission-clock-label">{state.clock.label}</div>
      <div className="mission-clock-value">{formatRemaining(state.clock.remaining_s)}</div>
    </div>
  );
}

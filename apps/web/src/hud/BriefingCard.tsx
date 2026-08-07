import { FINAL_APPROACH_01 } from '@docking/scenario';
import { launchScenario } from '../telemetry/scenarioEmitter';
import { useScenarioStore } from '../telemetry/scenarioStore';

export function BriefingCard() {
  const phase = useScenarioStore((state) => state.phase);
  if (phase !== 'BRIEFING') return null;

  return (
    <div className="mission-overlay" role="dialog" aria-label="mission briefing">
      <section className="mission-card">
        <div className="mission-card-kicker">MISSION BRIEFING</div>
        <h1>{FINAL_APPROACH_01.title}</h1>
        <p>{FINAL_APPROACH_01.briefing}</p>
        <button type="button" className="mission-primary-button" onClick={launchScenario}>LAUNCH</button>
      </section>
    </div>
  );
}

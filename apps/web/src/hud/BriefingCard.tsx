import { getSelectedScenario, launchScenario, selectMission } from '../telemetry/scenarioEmitter';
import { useScenarioStore } from '../telemetry/scenarioStore';
import './dockingLesson.css';

export function BriefingCard() {
  const { phase, selectedMission } = useScenarioStore();
  if (phase !== 'BRIEFING') return null;
  const scenario = getSelectedScenario();
  const first = selectedMission === 'FIRST_DOCKING';
  return <div className="mission-overlay" role="dialog" aria-label="mission briefing">
    <section className="mission-card">
      <div className="mission-card-kicker">LUCKY MARLIN · CHOOSE YOUR FLIGHT</div>
      <div className="mission-options">
        <button type="button" aria-pressed={first} onClick={() => selectMission('FIRST_DOCKING')}>First docking<small>Learn the controls · about 2 minutes<br />Assisted flight, no system failures</small></button>
        <button type="button" aria-pressed={!first} onClick={() => selectMission('EMERGENCY')}>Emergency approach<small>Advanced · 6 minutes<br />Manage failures while closing on the station</small></button>
      </div>
      <h1>{scenario.title}</h1><p>{scenario.briefing}</p>
      {first && <p>Start 6 m from the port. Use I/J/K/L to line up, then hold Shift to close gently. Space brakes and holds position. Attitude hold is already on.</p>}
      <button type="button" className="mission-primary-button" onClick={launchScenario}>{first ? 'Begin docking' : 'Launch emergency mission'}</button>
    </section>
  </div>;
}

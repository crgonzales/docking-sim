import { getSelectedScenario, retryScenario, selectMission } from '../telemetry/scenarioEmitter';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { dockingFailureAdvice } from './dockingGuidance';

export function DebriefCard() {
  const { state, selectedMission } = useScenarioStore();
  const scenario = getSelectedScenario();
  const first = selectedMission === 'FIRST_DOCKING';
  if (state?.phase !== 'DEBRIEF' || state.outcome === null) return null;

  const outcome = scenario.outcomes[state.outcome];
  const propUsed = state.score_inputs.prop_kg === null
    ? '----'
    : `${(scenario.initial.prop_kg - state.score_inputs.prop_kg).toFixed(2)} kg`;

  return (
    <div className="mission-overlay" role="dialog" aria-label="mission debrief">
      <section className="mission-card mission-debrief-card">
        <div className="mission-card-kicker">MISSION DEBRIEF</div>
        <h1>{outcome.title}</h1>
        <p>{first && state.outcome === 'COLLISION' ? dockingFailureAdvice(state.telemetry) : outcome.debrief}</p>
        {state.debrief_if_causal !== null && (
          <p className="mission-causal-debrief">{state.debrief_if_causal}</p>
        )}
        <div className="mission-score-summary">
          <div><span>PROP USED</span><strong>{propUsed}</strong></div>
          <div><span>{first ? 'FLIGHT TIME' : 'TIME MARGIN'}</span><strong>{(first ? state.clock.elapsed_s : state.score_inputs.time_margin_s).toFixed(1)} s</strong></div>
          <div><span>CORRIDOR VIOLATIONS</span><strong>{state.score_inputs.corridor_violations}</strong></div>
        </div>
        <button type="button" className="mission-primary-button" onClick={() => retryScenario()}>FLY AGAIN</button>
        {first && <button type="button" className="lesson-secondary" onClick={() => retryScenario('FINAL')}>Practise final 2 m</button>}
        <button type="button" className="lesson-secondary" onClick={() => selectMission(first && state.outcome === 'DOCKED' ? 'EMERGENCY' : selectedMission)}>{first && state.outcome === 'DOCKED' ? 'Try the emergency mission' : 'Mission selection'}</button>
      </section>
    </div>
  );
}

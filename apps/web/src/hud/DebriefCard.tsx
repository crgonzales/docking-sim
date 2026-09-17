import { getSelectedScenario, retryScenario, selectMission } from '../telemetry/scenarioEmitter';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { PRACTICE_EXPIRY_ADVICE, dockingAbortAdvice, dockingFailureAdvice } from './dockingGuidance';

export function DebriefCard() {
  const { state, selectedMission, startPoint } = useScenarioStore();
  const scenario = getSelectedScenario();
  const first = selectedMission === 'FIRST_DOCKING';
  if (state?.phase !== 'DEBRIEF' || state.outcome === null) return null;

  const outcome = scenario.outcomes[state.outcome];
  const propUsed = state.score_inputs.prop_kg === null
    ? '----'
    : `${(scenario.initial.prop_kg - state.score_inputs.prop_kg).toFixed(2)} kg`;
  // The lesson explains each ending from the last estimate; the emergency mission keeps its scenario text.
  const debrief = !first ? outcome.debrief
    : state.outcome === 'COLLISION' ? dockingFailureAdvice(state.telemetry)
    : state.outcome === 'PASSIVE_ABORT' ? dockingAbortAdvice(state.telemetry)
    : state.outcome === 'WINDOW_MISSED' ? PRACTICE_EXPIRY_ADVICE
    : outcome.debrief;

  return (
    <div className="mission-overlay" role="dialog" aria-label="mission debrief">
      <section className="mission-card mission-debrief-card">
        <div className="mission-card-kicker">MISSION DEBRIEF</div>
        <h1>{outcome.title}</h1>
        <p>{debrief}</p>
        {state.debrief_if_causal !== null && (
          <p className="mission-causal-debrief">{state.debrief_if_causal}</p>
        )}
        <div className="mission-score-summary">
          <div><span>PROP USED</span><strong>{propUsed}</strong></div>
          <div><span>{first ? 'FLIGHT TIME' : 'TIME MARGIN'}</span><strong>{(first ? state.clock.elapsed_s : state.score_inputs.time_margin_s).toFixed(1)} s</strong></div>
          {!first && <div><span>CORRIDOR VIOLATIONS</span><strong>{state.score_inputs.corridor_violations}</strong></div>}
        </div>
        <button type="button" className="mission-primary-button" onClick={() => retryScenario()}>FLY AGAIN</button>
        {first && (startPoint === 'FINAL'
          ? <button type="button" className="lesson-secondary" onClick={() => retryScenario('APPROACH')}>Back to the 6 m approach</button>
          : <button type="button" className="lesson-secondary" onClick={() => retryScenario('FINAL')}>Practise final 2 m</button>)}
        <button type="button" className="lesson-secondary" onClick={() => selectMission(first && state.outcome === 'DOCKED' ? 'EMERGENCY' : selectedMission)}>{first && state.outcome === 'DOCKED' ? 'Try the emergency mission' : 'Mission selection'}</button>
      </section>
    </div>
  );
}

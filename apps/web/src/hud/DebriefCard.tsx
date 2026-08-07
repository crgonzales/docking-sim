import { FINAL_APPROACH_01 } from '@docking/scenario';
import { retryScenario } from '../telemetry/scenarioEmitter';
import { useScenarioStore } from '../telemetry/scenarioStore';

export function DebriefCard() {
  const state = useScenarioStore((store) => store.state);
  if (state?.phase !== 'DEBRIEF' || state.outcome === null) return null;

  const outcome = FINAL_APPROACH_01.outcomes[state.outcome];
  const propUsed = state.score_inputs.prop_kg === null
    ? '----'
    : `${(FINAL_APPROACH_01.initial.prop_kg - state.score_inputs.prop_kg).toFixed(2)} kg`;

  return (
    <div className="mission-overlay" role="dialog" aria-label="mission debrief">
      <section className="mission-card mission-debrief-card">
        <div className="mission-card-kicker">MISSION DEBRIEF</div>
        <h1>{outcome.title}</h1>
        <p>{outcome.debrief}</p>
        {state.debrief_if_causal !== null && (
          <p className="mission-causal-debrief">{state.debrief_if_causal}</p>
        )}
        <div className="mission-score-summary">
          <div><span>PROP USED</span><strong>{propUsed}</strong></div>
          <div><span>TIME MARGIN</span><strong>{state.score_inputs.time_margin_s.toFixed(1)} s</strong></div>
          <div><span>CORRIDOR VIOLATIONS</span><strong>{state.score_inputs.corridor_violations}</strong></div>
        </div>
        <button type="button" className="mission-primary-button" onClick={retryScenario}>RETRY</button>
      </section>
    </div>
  );
}

import { useState } from 'react';
import { FLIGHT_EXERCISES, flightExerciseLabel, type FlightExerciseId } from './flightExercise';
import type { FlightSession } from './flightSession';

interface FlightExercisePanelProps {
  session: FlightSession;
  report: () => void;
}

const phaseLabel = (session: FlightSession): string => {
  const exercise = session.exerciseSnapshot();
  if (exercise.phase === 'TERMINAL') return `${exercise.terminalStatus ?? 'TERMINAL'} · STOPPED`;
  if (exercise.phase === 'COMPLETED') return 'COMPLETE · PAUSED';
  return exercise.phase;
};

export function FlightExercisePanel({ session, report }: FlightExercisePanelProps) {
  const [selected, setSelected] = useState<FlightExerciseId>('TURN_RIGHT');
  const exercise = session.exerciseSnapshot();
  const running = exercise.phase === 'RUNNING';
  const selectedDefinition = FLIGHT_EXERCISES.find((candidate) => candidate.id === selected);
  const start = () => { session.startExercise(selected); report(); };
  const stop = () => { session.stopExercise(); report(); };
  return <aside className="flight-exercise-panel" aria-label="Development flight exercise">
    <div className="flight-panel-top"><span>DEV EXERCISE</span><b>PROBE</b></div>
    <label className="flight-exercise-select">MANEUVER
      <select aria-label="Exercise maneuver" value={selected} disabled={running} onChange={(event) => setSelected(event.target.value as FlightExerciseId)}>
        {FLIGHT_EXERCISES.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
      </select>
    </label>
    <p className="flight-exercise-description">{selectedDefinition?.description}</p>
    <div className="flight-exercise-state"><span>{exercise.id ? flightExerciseLabel(exercise.id) : 'Ready'}</span><b>{phaseLabel(session)}</b></div>
    <progress max={1} value={exercise.progress} aria-label="Exercise progress" />
    <div className="flight-exercise-progress">{Math.round(exercise.progress * 100)}% · {exercise.elapsed_s.toFixed(1)} / {exercise.duration_s.toFixed(1)} s</div>
    <div className="flight-actions flight-exercise-actions">
      <button type="button" onClick={start} disabled={running}>Start</button>
      <button type="button" onClick={stop} disabled={!running}>Stop</button>
    </div>
    <small>Start trims and resets airborne. Manual input, pause, reset or blur cancels.</small>
  </aside>;
}

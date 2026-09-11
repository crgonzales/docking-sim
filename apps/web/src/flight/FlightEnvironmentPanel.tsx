import { useState, useSyncExternalStore } from 'react';
import {
  ENVIRONMENT_TIME_SCALES,
  environmentSecondsFromInput,
  environmentTimeInputValue,
  formatEnvironmentTime,
  type FlightEnvironmentClock,
} from './flightEnvironment';

export interface FlightEnvironmentPanelProps {
  readonly environment: FlightEnvironmentClock;
  readonly onTogglePause: () => void;
  readonly onReset: () => void;
  readonly onChanged: () => void;
}

const PRESETS = [
  ['Dawn', 6],
  ['Morning', 10],
  ['Noon', 12],
  ['Afternoon', 15],
  ['Sunset', 18],
  ['Night', 22],
] as const;

function speedLabel(value: number): string {
  return `${value}x`;
}

/** Compact flight-owned clock controls; all user-facing copy stays product-neutral. */
export function FlightEnvironmentPanel({ environment, onTogglePause, onReset, onChanged }: FlightEnvironmentPanelProps): React.JSX.Element {
  const state = useSyncExternalStore(environment.subscribe, environment.getSnapshot, environment.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const canEdit = state.paused;
  const inputValue = environmentTimeInputValue(state.localSolarTimeHours * 3600);

  const seek = (seconds: number): void => {
    environment.seekLocalSolarHours(seconds / 3600);
    onChanged();
  };

  return <aside className={`flight-environment-panel${expanded ? ' is-expanded' : ''}`} aria-label="Environment clock">
    <button
      className="flight-environment-summary"
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <span>ENVIRONMENT</span>
      <strong>{formatEnvironmentTime(state.localSolarTimeHours * 3600)} · {speedLabel(state.timeScale)}</strong>
      <em>{state.paused ? 'PAUSED' : state.daylight ? 'DAYLIGHT' : 'NIGHT'}</em>
    </button>
    {expanded && <div className="flight-environment-body">
      <label className="flight-environment-time">
        <span>LOCAL SOLAR TIME</span>
        <input
          aria-label="Local solar time"
          type="time"
          step="60"
          value={inputValue}
          disabled={!canEdit}
          onInput={(event) => {
            const seconds = environmentSecondsFromInput(event.currentTarget.value);
            if (seconds !== null) seek(seconds);
          }}
        />
      </label>
      <div className="flight-environment-presets" aria-label="Time presets">
        {PRESETS.map(([label, hour]) => <button key={label} type="button" disabled={!canEdit} onClick={() => { environment.seekLocalSolarHours(hour); onChanged(); }}>{label}</button>)}
      </div>
      <label className="flight-environment-speed">
        <span>SPEED</span>
        <select
          aria-label="Environment time speed"
          value={state.timeScale}
          disabled={!canEdit}
          onChange={(event) => {
            environment.setTimeScale(Number(event.target.value));
            onChanged();
          }}
        >
          {ENVIRONMENT_TIME_SCALES.map((scale) => <option key={scale} value={scale}>{speedLabel(scale)}</option>)}
        </select>
      </label>
      <div className="flight-environment-actions">
        <button type="button" onClick={onTogglePause}>{state.paused ? 'Resume · P' : 'Pause · P'}</button>
        <button type="button" onClick={onReset}>Reset time</button>
      </div>
      <small>{canEdit ? 'Choose a time or preview speed while paused.' : 'Pause flight to edit environment time.'}</small>
    </div>}
  </aside>;
}

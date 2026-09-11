import { useState } from 'react';
import type { FlightGraphicsConfig, FlightGraphicsPreset } from './flightGraphics';

export interface FlightGraphicsPanelProps {
  readonly graphics: FlightGraphicsConfig;
  readonly paused: boolean;
  readonly onPresetChange: (preset: FlightGraphicsPreset) => void;
}

const PRESETS: readonly { readonly id: FlightGraphicsPreset; readonly label: string; readonly description: string }[] = [
  { id: 'balanced', label: 'Balanced', description: 'Smooth edges and detailed surfaces with a lighter graphics workload.' },
  { id: 'high', label: 'High', description: 'Sharper edges, distant textures and local shadows. Uses more graphics memory.' },
];

/** Compact, flight-owned graphics controls. Changes are intentionally pause-only. */
export function FlightGraphicsPanel({ graphics, paused, onPresetChange }: FlightGraphicsPanelProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return <aside className="flight-graphics-panel" aria-label="Graphics quality">
    <button
      className="flight-graphics-summary"
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <span>GRAPHICS</span>
      <strong>{graphics.preset === 'high' ? 'HIGH' : 'BALANCED'}</strong>
      <em>{paused ? 'PAUSED · READY TO CHANGE' : 'PAUSE TO CHANGE'}</em>
    </button>
    {expanded && <div className="flight-graphics-body">
      <div className="flight-graphics-presets" aria-label="Graphics quality presets">
        {PRESETS.map(({ id, label }) => <button
          key={id}
          type="button"
          aria-pressed={graphics.preset === id}
          disabled={!paused}
          onClick={() => onPresetChange(id)}
        >{label}</button>)}
      </div>
      <small>{PRESETS.find(({ id }) => id === graphics.preset)?.description} {paused ? 'Changes apply without resetting the flight.' : 'Pause flight to change quality.'}</small>
    </div>}
  </aside>;
}

import { useTelemetryBus } from '../telemetry/bus';

const OUTCOME_COPY = {
  DOCKED: { title: 'CAPTURE CONFIRMED', subline: 'DOCKING ENVELOPE SATISFIED', className: 'docked' },
  COLLISION: { title: 'CONTACT OUTSIDE ENVELOPE', subline: 'CAPTURE CRITERIA FAILED', className: 'collision' },
  ABORT: { title: 'ABORT - SAFE COAST', subline: 'PASSIVE SAFING SEQUENCE ACTIVE', className: 'abort' },
} as const;

export function OutcomeBanner() {
  const outcome = useTelemetryBus((state) => state.frame?.outcome ?? 'NONE');
  if (outcome === 'NONE') return null;
  const copy = OUTCOME_COPY[outcome];

  return (
    <div className={`hud-outcome-banner ${copy.className}`} role="status">
      <div className="hud-outcome-title">{copy.title}</div>
      <div className="hud-outcome-subline">{copy.subline}</div>
    </div>
  );
}

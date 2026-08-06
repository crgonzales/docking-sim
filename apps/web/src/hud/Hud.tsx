import './hud.css';
import { CautionWarningPanel } from './CautionWarningPanel';
import { ModeBar } from './ModeBar';
import { TelemetryStrip } from './TelemetryStrip';

/** HUD overlay composition — display only in Phase 1 (no pointer events). */
export function Hud() {
  return (
    <div className="hud">
      <TelemetryStrip />
      <CautionWarningPanel />
      <ModeBar />
    </div>
  );
}

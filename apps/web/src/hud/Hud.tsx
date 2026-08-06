import './hud.css';
import { CautionWarningPanel } from './CautionWarningPanel';
import { ModeBar } from './ModeBar';
import { TelemetryStrip } from './TelemetryStrip';
import { useViewStore } from '../viewStore';

/** HUD overlay composition — display only in Phase 1 (no pointer events). */
export function Hud() {
  const viewMode = useViewStore((state) => state.mode);
  return (
    <div className="hud">
      <TelemetryStrip />
      <CautionWarningPanel />
      <ModeBar />
      {viewMode === 'COCKPIT' && <div className="cockpit-viewport-frame" aria-hidden="true" />}
    </div>
  );
}

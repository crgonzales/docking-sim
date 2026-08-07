import './hud.css';
import { CautionWarningPanel } from './CautionWarningPanel';
import { KeybindsOverlay } from './KeybindsOverlay';
import { ModeBar } from './ModeBar';
import { OutcomeBanner } from './OutcomeBanner';
import { TelemetryStrip } from './TelemetryStrip';
import { useViewStore } from '../viewStore';

/** HUD overlay composition — display only in Phase 1 (no pointer events). */
export function Hud() {
  const viewMode = useViewStore((state) => state.mode);
  return (
    <div className="hud">
      <TelemetryStrip />
      <CautionWarningPanel />
      <KeybindsOverlay />
      <OutcomeBanner />
      <ModeBar />
      <div className="hud-controls-hint">H CONTROLS</div>
      {viewMode === 'COCKPIT' && <div className="cockpit-viewport-frame" aria-hidden="true" />}
    </div>
  );
}

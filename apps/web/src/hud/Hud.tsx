import './hud.css';
import { useAppModeStore } from '../appModeStore';
import { BriefingCard } from './BriefingCard';
import { CautionWarningPanel } from './CautionWarningPanel';
import { DebriefCard } from './DebriefCard';
import { KeybindsOverlay } from './KeybindsOverlay';
import { MissionClock } from './MissionClock';
import { ModeBar } from './ModeBar';
import { OutcomeBanner } from './OutcomeBanner';
import { SwitchPanel } from './SwitchPanel';
import { TelemetryStrip } from './TelemetryStrip';
import { useViewStore } from '../viewStore';

/** HUD overlay composition — display only in Phase 1 (no pointer events). */
export function Hud() {
  const appMode = useAppModeStore((state) => state.mode);
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
      {appMode === 'MISSION' && <>
        <SwitchPanel />
        <MissionClock />
        <BriefingCard />
        <DebriefCard />
      </>}
    </div>
  );
}

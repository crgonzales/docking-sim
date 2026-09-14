import './hud.css';
import { DockingLesson } from './FirstDockingHud';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { resumeScenario } from '../telemetry/scenarioEmitter';
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
  const first = useScenarioStore(s => s.selectedMission === 'FIRST_DOCKING');
  const paused = useScenarioStore(s => s.paused);
  const viewMode = useViewStore((state) => state.mode);
  if (appMode === 'MISSION' && first) return <div className="hud">
    <DockingLesson /><KeybindsOverlay /><ModeBar simple /><BriefingCard /><DebriefCard />
  </div>;
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
        {paused && <div className="mission-overlay" role="dialog" aria-label="mission paused"><section className="mission-card"><h1>Flight paused</h1><p>The mission clock is paused and held inputs are released.</p><button type="button" className="mission-primary-button" onClick={resumeScenario}>Resume flight</button></section></div>}
      </>}
    </div>
  );
}

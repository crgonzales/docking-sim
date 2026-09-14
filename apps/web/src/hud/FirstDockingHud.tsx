import { useState, type PointerEvent } from 'react';
import type { ManualCommand } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { holdPosition, pauseScenario, resumeScenario, retryScenario, setLessonPadCommand, togglePrecision, toggleApproach } from '../telemetry/scenarioEmitter';
import { useViewStore } from '../viewStore';
import { dockingLesson } from './dockingGuidance';
import { TelemetryStrip } from './TelemetryStrip';
import './dockingLesson.css';

const ZERO: ManualCommand = { translation: [0, 0, 0], rotation: [0, 0, 0] };
function ThrustButton({ label, axis, sign }: { label: string; axis: number; sign: number }) {
  const release = () => setLessonPadCommand(ZERO);
  const thrust = () => {
    const command: ManualCommand = { translation: [0, 0, 0], rotation: [0, 0, 0] };
    command.translation[axis] = sign;
    setLessonPadCommand(command);
  };
  const press = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    thrust();
  };
  return <button type="button" onPointerDown={press} onPointerUp={release} onPointerCancel={release}
    onKeyDown={event => { if (event.key === ' ') event.stopPropagation(); }}
    onClick={event => { if (event.detail === 0) { thrust(); release(); } }}
    onLostPointerCapture={release} aria-label={`Hold to ${label.toLowerCase()}`}>{label}</button>;
}

export function DockingLesson() {
  const frame = useTelemetryBus(s => s.frame);
  const { phase, paused, precision, startPoint, approaching } = useScenarioStore();
  const [systems, setSystems] = useState(false);
  const lesson = dockingLesson(frame, precision);
  const status = ['Line up the ports', 'Approach the station', 'Make a gentle capture', 'Docking complete'];
  return <>
    <header className="lesson-heading"><span>LUCKY MARLIN · FLIGHT SCHOOL</span><h1>First docking</h1></header>
    {phase === 'RUNNING' && <>
      <div className="lesson-readouts" aria-label="docking guidance">
        <div><span>TO CONTACT</span><strong>{lesson ? Math.max(0, lesson.gap).toFixed(2) : '—'} <small>m</small></strong></div>
        <div><span>CLOSING SPEED</span><strong className={lesson?.speedSafe ? 'ready' : ''}>{frame?.docking?.closing_mps.toFixed(2) ?? '—'} <small>m/s</small></strong></div>
        <div><span>PORT OFFSET</span><strong className={lesson?.aligned ? 'ready' : ''}>{lesson?.lateral.toFixed(2) ?? '—'} <small>m</small></strong></div>
      </div>
      <section className="lesson-panel" aria-label="first docking controls">
        <ol className="lesson-steps" aria-label="docking steps">{['Align', 'Approach', 'Capture'].map((step, i) => <li key={step} className={i === lesson?.stage ? 'current' : ''}>{i + 1} {step}</li>)}</ol>
        <h2>{lesson ? status[lesson.stage] : 'Acquiring navigation…'}</h2>
        <p className="lesson-hint">{approaching && lesson?.aligned && lesson.stable && lesson.speedSafe
          ? 'Forward input is held. Watch the alignment and speed; press Space to brake and hold position.'
          : lesson?.hint ?? 'The instruments will appear when the first navigation sample arrives.'}</p>
        <div className="lesson-alignment">
          <svg viewBox="0 0 120 120" role="img" aria-label="Port alignment: move the diamond to the centre">
            <path d="M60 8v104M8 60h104" stroke="currentColor" opacity=".25" />
            <circle cx="60" cy="60" r="10" fill="none" stroke="currentColor" />
            {lesson && <path d="M0 -6L6 0L0 6L-6 0Z" fill={lesson.aligned ? '#70efb5' : '#ffca80'}
              transform={`translate(${60 + Math.max(-46, Math.min(46, lesson.body[0] * 100))} ${60 - Math.max(-46, Math.min(46, lesson.body[2] * 100))})`} />}
          </svg>
          <div><span>PORT ALIGNMENT</span><b>{frame?.docking?.misalign_deg.toFixed(1) ?? '—'}° <small>/ 4°</small></b><b>{frame?.docking?.rate_dps.toFixed(2) ?? '—'}°/s <small>/ 0.15°/s</small></b><p>I J K L · slide<br />W A S D / Q E · rotate</p></div>
        </div>
        <div className="lesson-actions">
          <button type="button" aria-pressed={precision} onClick={togglePrecision}>{precision ? 'Precision · 0.07 m/s' : 'Approach · 0.25 m/s'} <kbd>X</kbd></button>
          <button type="button" aria-pressed={approaching} onClick={toggleApproach}>{approaching ? 'Approaching · click to stop input' : 'Keep approaching'}</button>
          <button type="button" onClick={holdPosition}>Hold position <kbd>SPACE</kbd></button>
        </div>
        <div className="lesson-thrust" aria-label="mouse translation controls">
          <ThrustButton label="Left · J" axis={0} sign={-1} /><ThrustButton label="Up · I" axis={2} sign={1} /><ThrustButton label="Right · L" axis={0} sign={1} />
          <ThrustButton label="Back · Ctrl" axis={1} sign={-1} /><ThrustButton label="Down · K" axis={2} sign={-1} /><ThrustButton label="Forward · Shift" axis={1} sign={1} />
        </div>
        <p className="lesson-footnote">Hold a key or button; a quick click gives a small nudge. Keep approaching holds forward input for you. Space brakes.</p>
        <div className="lesson-utility"><button type="button" onClick={pauseScenario}>Pause <kbd>P</kbd></button><button type="button" onClick={() => retryScenario()}>Retry <kbd>R</kbd></button><button type="button" onClick={() => useViewStore.getState().cycleMode()}>Camera <kbd>C</kbd></button></div>
        <button type="button" className="lesson-systems" onClick={() => setSystems(!systems)} aria-expanded={systems}>{systems ? 'Hide' : 'Show'} instruments</button>
      </section>
      <div className="lesson-progress" aria-label="approach progress"><span>{startPoint === 'FINAL' ? 'FINAL 2 m PRACTICE' : '6 m APPROACH'}</span><progress max={startPoint === 'FINAL' ? 2 : 6} value={Math.max(0, (startPoint === 'FINAL' ? 2 : 6) - (lesson?.gap ?? 6))} /><span>DOCK</span></div>
      {systems && <div className="lesson-extra"><TelemetryStrip /></div>}
      {paused && <div className="mission-overlay lesson-pause" role="dialog" aria-label="mission paused"><section className="mission-card"><div className="mission-card-kicker">FLIGHT PAUSED</div><h1>Take your time.</h1><p>The spacecraft and mission clock are paused. Your controls have been released.</p><button type="button" className="mission-primary-button" onClick={resumeScenario}>Resume flight</button><button type="button" className="lesson-secondary" onClick={() => retryScenario('FINAL')}>Practise final 2 m</button><button type="button" className="lesson-secondary" onClick={() => retryScenario()}>Restart approach</button></section></div>}
    </>}
  </>;
}

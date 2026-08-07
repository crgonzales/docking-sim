import { useEffect, useRef, useState } from 'react';
import { FINAL_APPROACH_01 } from '@docking/scenario';
import type { ControlMode, NavSource } from '@docking/sim-core';
import { useAppModeStore } from '../appModeStore';
import { playClick, setMasterAlarmTone } from './panelAudio';
import { useScenarioStore } from '../telemetry/scenarioStore';
import {
  commandAbort,
  dispatchPlayerAction,
  isolateThruster,
  setControlMode,
  setNavSource,
} from '../telemetry/scenarioEmitter';

const CONTROLLERS = ['PID', 'LQR', 'MPC'] as const;
const GUARD_TIMEOUT_MS = 3_000;

function useGuard(): [boolean, () => void, () => void] {
  const [guarded, setGuarded] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setGuarded(true);
  };
  const lift = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    setGuarded(false);
    timer.current = setTimeout(close, GUARD_TIMEOUT_MS);
  };

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  return [guarded, lift, close];
}

function controlClass(id: string, hintControl: string | null): string {
  return `mission-control ${FINAL_APPROACH_01.assist_default === 'GUIDED' && hintControl === id ? 'hinted' : ''}`;
}

interface GuardedButtonProps {
  id: string;
  label: string;
  guarded: boolean;
  onClick: () => void;
  className: string;
}

function GuardedButton({ id, label, guarded, onClick, className }: GuardedButtonProps) {
  return (
    <button type="button" id={id} className={`${className} ${guarded ? 'guarded' : 'guard-lifted'}`} onClick={onClick}>
      <span className="mission-control-label">{label}</span>
      <span className="mission-control-state">{guarded ? 'GUARD' : 'READY'}</span>
    </button>
  );
}

/** Mission command panel. Every scenario action enters through scenarioEmitter. */
export function SwitchPanel() {
  const mode = useAppModeStore((state) => state.mode);
  const scenarioState = useScenarioStore((state) => state.state);
  const [j6Isolated, setJ6Isolated] = useState(false);
  const [masterSilenced, setMasterSilenced] = useState(false);
  const [j6Guarded, liftJ6, closeJ6] = useGuard();
  const [manualGuarded, liftManual, closeManual] = useGuard();
  const [abortGuarded, liftAbort, closeAbort] = useGuard();
  const previousAlarm = useRef(scenarioState?.alarm_level ?? null);

  useEffect(() => {
    const alarm = scenarioState?.alarm_level ?? null;
    if (alarm === 'MASTER' && previousAlarm.current !== 'MASTER') setMasterSilenced(false);
    previousAlarm.current = alarm;
  }, [scenarioState?.alarm_level]);

  // A retry tears down the sim but not this component: leaving DEBRIEF for a
  // fresh RUNNING phase must clear per-run latches (J6 valve, alarm silence).
  const previousPhase = useRef(scenarioState?.phase ?? null);
  useEffect(() => {
    const phase = scenarioState?.phase ?? null;
    if (phase === 'RUNNING' && previousPhase.current === 'DEBRIEF') {
      setJ6Isolated(false);
      setMasterSilenced(false);
    }
    previousPhase.current = phase;
  }, [scenarioState?.phase]);

  const masterLit = scenarioState?.alarm_level === 'MASTER' && !masterSilenced;
  const phase = scenarioState?.phase ?? null;
  useEffect(() => {
    // Uncleared beats stay in active_callouts after an outcome latches, so
    // without the RUNNING gate the alarm would keep sounding under the
    // debrief overlay.
    setMasterAlarmTone(masterLit && mode === 'MISSION' && phase === 'RUNNING');
    return () => setMasterAlarmTone(false);
  }, [masterLit, mode, phase]);

  if (mode !== 'MISSION') return null;

  const hintControl = scenarioState?.hint_control ?? null;
  const telemetry = scenarioState?.telemetry;
  const navSource: NavSource = telemetry?.nav_source ?? 'PRIMARY';
  const controlMode: ControlMode = telemetry?.control_mode ?? 'AUTO';
  const controller = telemetry?.controller ?? FINAL_APPROACH_01.initial.controller;

  const onJ6Click = (): void => {
    playClick();
    if (j6Guarded) {
      liftJ6();
      return;
    }
    isolateThruster('J6');
    setJ6Isolated(true);
    closeJ6();
  };
  const onManualClick = (): void => {
    playClick();
    if (manualGuarded) {
      liftManual();
      return;
    }
    setControlMode(controlMode === 'MANUAL' ? 'AUTO' : 'MANUAL');
    closeManual();
  };
  const onAbortClick = (): void => {
    playClick();
    if (abortGuarded) {
      liftAbort();
      return;
    }
    commandAbort();
    closeAbort();
  };
  const onMasterClick = (): void => {
    playClick();
    setMasterSilenced(true);
  };

  return (
    <section className="mission-switch-panel" aria-label="mission controls">
      <div className="mission-panel-title">MISSION SWITCH PANEL</div>
      <div className="mission-panel-grid">
        <div className={controlClass('NAV_SRC', hintControl)}>
          <span className="mission-control-label">NAV SRC</span>
          <div className="mission-segmented">
            {(['PRIMARY', 'BACKUP'] as const).map((source) => (
              <button
                type="button"
                key={source}
                className={navSource === source ? 'active' : ''}
                onClick={() => { playClick(); setNavSource(source); }}
              >
                {source}
              </button>
            ))}
          </div>
        </div>

        <GuardedButton
          id="RCS_ISO_J6"
          label={j6Isolated ? 'J6 ISOLATED' : 'RCS ISO J6'}
          guarded={j6Guarded}
          onClick={onJ6Click}
          className={controlClass('RCS_ISO_J6', hintControl)}
        />

        <div className={controlClass('CTRL_MODE', hintControl)}>
          <span className="mission-control-label">CTRL MODE</span>
          <div className="mission-segmented mission-three-way">
            {CONTROLLERS.map((value) => (
              <button
                type="button"
                key={value}
                className={controller === value ? 'active' : ''}
                onClick={() => { playClick(); dispatchPlayerAction({ kind: 'SET_CONTROLLER', to: value }); }}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <GuardedButton
          id="AUTO_MANUAL"
          label={controlMode === 'MANUAL' ? 'MANUAL' : 'AUTO / MANUAL'}
          guarded={manualGuarded}
          onClick={onManualClick}
          className={controlClass('AUTO_MANUAL', hintControl)}
        />

        <button
          type="button"
          id="MASTER_ALARM"
          className={`${controlClass('MASTER_ALARM', hintControl)} mission-control mission-pushbutton ${masterLit ? 'lit' : ''}`}
          onClick={onMasterClick}
        >
          <span className="mission-control-label">MASTER ALARM</span>
          <span className="mission-control-state">{masterLit ? 'LIT' : 'SILENCED'}</span>
        </button>

        <GuardedButton
          id="ABORT"
          label="ABORT"
          guarded={abortGuarded}
          onClick={onAbortClick}
          className={`${controlClass('ABORT', hintControl)} mission-abort-control`}
        />
      </div>
    </section>
  );
}

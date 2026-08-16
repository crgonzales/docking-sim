import { useState } from 'react';
import { useTelemetryBus } from '../telemetry/bus';
import {
  getMasterMuted,
  getMasterVolume,
  setMasterMuted,
  setMasterVolume,
} from './audioContext';

const CONTROLLERS = ['PID', 'LQR', 'MPC'] as const;
const CONTROL_MODES = ['AUTO', 'MANUAL'] as const;
const MANUAL_SUB_MODES = ['RATE', 'PULSE'] as const;

/** Bottom mode bar: active controller, control mode, sim clock. */
export function ModeBar() {
  const frame = useTelemetryBus((s) => s.frame);
  const [muted, setMuted] = useState(getMasterMuted);
  const [volume, setVolume] = useState(getMasterVolume);

  return (
    <div className="hud-modebar">
      <div className="hud-mode-group">
        {CONTROLLERS.map((c) => (
          <span key={c} className={`hud-mode ${frame?.controller === c ? 'active' : ''}`}>
            {c}
          </span>
        ))}
      </div>
      <div className="hud-mode-group">
        {CONTROL_MODES.map((m) => (
          <span key={m} className={`hud-mode ${frame?.control_mode === m ? 'active' : ''}`}>
            {m}
          </span>
        ))}
      </div>
      <div className="hud-mode-group hud-submode-group">
        {MANUAL_SUB_MODES.map((mode) => (
          <span key={mode} className={`hud-chip ${frame?.manual_sub_mode === mode ? 'active' : ''}`}>
            {mode}
          </span>
        ))}
      </div>
      <div className="hud-mode-group hud-submode-group">
        {(['LOW', 'HIGH'] as const).map((authority) => (
          <span key={authority} className={`hud-chip ${frame?.manual_authority === authority ? 'active' : ''}`}>
            {authority}
          </span>
        ))}
      </div>
      <div className="hud-audio-control" aria-label="flight audio volume">
        <button
          type="button"
          aria-label={muted ? 'unmute flight audio' : 'mute flight audio'}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            setMasterMuted(next);
          }}
        >
          {muted ? 'AUDIO OFF' : 'AUDIO'}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          aria-label="master volume"
          onChange={(event) => {
            const next = Number(event.target.value);
            setVolume(next);
            setMasterVolume(next);
          }}
        />
      </div>
      <div className="hud-clock">
        {frame ? `sim ${frame.t_s.toFixed(1)} s` : 'sim ----'}
      </div>
    </div>
  );
}

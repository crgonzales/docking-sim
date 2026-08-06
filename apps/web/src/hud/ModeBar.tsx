import { useTelemetryBus } from '../telemetry/bus';

const CONTROLLERS = ['PID', 'LQR', 'MPC'] as const;
const CONTROL_MODES = ['AUTO', 'MANUAL'] as const;
const MANUAL_SUB_MODES = ['RATE', 'PULSE'] as const;

/** Bottom mode bar: active controller, control mode, sim clock. */
export function ModeBar() {
  const frame = useTelemetryBus((s) => s.frame);

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
      <div className="hud-clock">
        {frame ? `sim ${frame.t_s.toFixed(1)} s` : 'sim ----'}
      </div>
    </div>
  );
}

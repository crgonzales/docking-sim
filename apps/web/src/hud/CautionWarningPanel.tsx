import { useTelemetryBus } from '../telemetry/bus';

export type CwTileState = 'off' | 'caution' | 'warning';

export interface CwTile {
  id: string;
  label: string;
  state: CwTileState;
}

/** Live caution/warning tiles driven by the additive FSW telemetry fields. */
export function CautionWarningPanel() {
  const frame = useTelemetryBus((state) => state.frame);
  const tiles: CwTile[] = [
    { id: 'NAV', label: 'nav', state: 'off' },
    { id: 'RCS', label: 'rcs', state: 'off' },
    { id: 'GUID', label: 'guid', state: frame?.mpc_fallback ? 'caution' : 'off' },
    {
      id: 'CTRL',
      label: 'ctrl',
      state: frame?.outcome === 'ABORT' ? 'warning' : typeof frame?.corridor_err_m === 'number' && frame.corridor_err_m > 0 ? 'caution' : 'off',
    },
    { id: 'PROP', label: 'prop', state: 'off' },
    { id: 'COMM', label: 'comm', state: 'off' },
  ];

  return (
    <div className="hud-cw">
      <div className="hud-cw-title">caution / warning</div>
      {tiles.map((tile) => (
        <div key={tile.id} className={`hud-cw-tile ${tile.state === 'off' ? '' : tile.state}`}>
          {tile.label}
        </div>
      ))}
    </div>
  );
}

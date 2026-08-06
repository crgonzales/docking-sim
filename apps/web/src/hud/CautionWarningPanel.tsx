/**
 * Caution & warning tile grid. Phase 1 delivers the layout and tile
 * component with every system dark/inactive; later phases drive `state`
 * from real monitors via the telemetry bus.
 */
export type CwTileState = 'off' | 'caution' | 'warning';

export interface CwTile {
  id: string;
  label: string;
  state: CwTileState;
}

const TILES: CwTile[] = [
  { id: 'NAV', label: 'nav', state: 'off' },
  { id: 'RCS', label: 'rcs', state: 'off' },
  { id: 'GUID', label: 'guid', state: 'off' },
  { id: 'CTRL', label: 'ctrl', state: 'off' },
  { id: 'PROP', label: 'prop', state: 'off' },
  { id: 'COMM', label: 'comm', state: 'off' },
];

export function CautionWarningPanel() {
  return (
    <div className="hud-cw">
      <div className="hud-cw-title">caution / warning</div>
      {TILES.map((tile) => (
        <div key={tile.id} className={`hud-cw-tile ${tile.state === 'off' ? '' : tile.state}`}>
          {tile.label}
        </div>
      ))}
    </div>
  );
}

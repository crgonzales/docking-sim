import { BINDINGS, type BindingGroup } from '../input/bindings';
import { useViewStore } from '../viewStore';

const GROUPS: readonly BindingGroup[] = ['MODE', 'TRANSLATE', 'ROTATE', 'CAMERA', 'SAFETY'];

export function KeybindsOverlay() {
  const open = useViewStore((state) => state.keybindsOpen);
  if (!open) return null;

  return (
    <div className="hud-keybinds" role="dialog" aria-label="keybinds">
      <div className="hud-keybinds-title">H CONTROLS</div>
      {GROUPS.map((group) => (
        <section className="hud-keybinds-group" key={group}>
          <div className="hud-keybinds-group-title">{group}</div>
          {BINDINGS.filter((binding) => binding.group === group).map((binding) => (
            <div className="hud-keybind" key={binding.id}>
              <span className="hud-keybind-code">{binding.label}</span>
              <span>{binding.description}</span>
            </div>
          ))}
        </section>
      ))}
      <section className="hud-keybinds-group">
        <div className="hud-keybinds-group-title">CREDITS</div>
        <div className="hud-keybind">
          <span>
            Starfield: &ldquo;The Milky Way panorama&rdquo; &mdash; ESO/S.&nbsp;Brunier,
            CC&nbsp;BY&nbsp;4.0 (creativecommons.org/licenses/by/4.0).
            Modified: downscaled to 4096&times;2048.
          </span>
        </div>
        <div className="hud-keybind">
          <span>Earth imagery: NASA Visible Earth (Blue Marble, Earth at Night, cloud composite) &mdash; public domain.</span>
        </div>
        <div className="hud-keybind">
          <span>Spacecraft models: NASA 3D Resources &mdash; public domain.</span>
        </div>
      </section>
    </div>
  );
}

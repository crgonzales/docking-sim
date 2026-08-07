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
    </div>
  );
}

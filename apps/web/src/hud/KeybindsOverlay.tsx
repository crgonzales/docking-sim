import { BINDINGS, type BindingGroup } from '../input/bindings';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { useAppModeStore } from '../appModeStore';
import { useViewStore } from '../viewStore';

const GROUPS: readonly BindingGroup[] = ['MODE', 'TRANSLATE', 'ROTATE', 'CAMERA', 'SAFETY'];

export function KeybindsOverlay() {
  const appMode = useAppModeStore(s => s.mode);
  const first = useScenarioStore(s => s.selectedMission === 'FIRST_DOCKING');
  const lesson = appMode === 'MISSION' && first;
  const open = useViewStore((state) => state.keybindsOpen);
  const viewMode = useViewStore((state) => state.mode);
  const debugSubmode = useViewStore((state) => state.debugSubmode);
  if (!open) return null;
  const flyActive = viewMode === 'DEBUG' && debugSubmode === 'FLY';

  const descriptionFor = (id: string, description: string): string => {
    if (!flyActive) return description;
    if (id === 'pitchDown') return 'FLY forward';
    if (id === 'pitchUp') return 'FLY backward';
    if (id === 'yawLeft') return 'FLY strafe left';
    if (id === 'yawRight') return 'FLY strafe right';
    return description;
  };

  return (
    <div className="hud-keybinds" role="dialog" aria-label="keybinds">
      <div className="hud-keybinds-title">H CONTROLS</div>
      {GROUPS.map((group) => (
        <section className="hud-keybinds-group" key={group}>
          <div className="hud-keybinds-group-title">{group}</div>
          {BINDINGS.filter((binding) => binding.group === group && (!binding.lessonOnly || lesson) && !(lesson && ['toggleControlMode', 'toggleManualSubMode', 'toggleManualAuthority', 'cycleController'].includes(binding.id))).map((binding) => (
            <div className="hud-keybind" key={binding.id}>
              <span className="hud-keybind-code">{binding.label}</span>
              <span>{descriptionFor(binding.id, binding.description)}</span>
            </div>
          ))}
        </section>
      ))}
      <section className="hud-keybinds-group">
        <div className="hud-keybinds-group-title">DEBUG FLY</div>
        <div className="hud-keybind">
          <span className="hud-keybind-code">F</span>
          <span>toggle DEBUG ORBIT / FLY ({flyActive ? 'FLY active' : 'ORBIT active'})</span>
        </div>
        <div className="hud-keybind">
          <span className="hud-keybind-code">W A S D</span>
          <span>{flyActive ? 'camera flight — DEBUG FLY owns movement keys' : 'spacecraft manual rotation outside FLY'}</span>
        </div>
        <div className="hud-keybind">
          <span className="hud-keybind-code">RIGHT DRAG</span>
          <span>{flyActive ? 'free-look — DEBUG FLY owns mouse' : 'orbit camera'}</span>
        </div>
      </section>
      <section className="hud-keybinds-group">
        <div className="hud-keybinds-group-title">CREDITS</div>
        <div className="hud-keybind">
          <span>
            Crew Dragon: &ldquo;SpaceX - Dragon 2&rdquo; &mdash; KUBAHA, CC&nbsp;BY&nbsp;4.0
            (creativecommons.org/licenses/by/4.0). Modified: scale normalized, nose cover opened, materials adjusted.
          </span>
        </div>
        <div className="hud-keybind">
          <span>
            F/A-18C: &ldquo;McDonnell Douglas F/A-18C Hornet&rdquo; &mdash; Rhine_Lab_Muelsyse, CC&nbsp;BY&nbsp;4.0.
            Modified: rescaled to 17.06&nbsp;m, deployed gear and stores hidden.
          </span>
        </div>
        <div className="hud-keybind">
          <span>Earth imagery: NASA Visible Earth Blue Marble and water mask; terrain from NOAA ETOPO 2022 and USGS 3DEP &mdash; public domain.</span>
        </div>
        <div className="hud-keybind">
          <span>Spacecraft models: NASA 3D Resources &mdash; public domain.</span>
        </div>
      </section>
    </div>
  );
}

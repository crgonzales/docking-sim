import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachManualControls } from './manualControls';
import { useAppModeStore } from '../appModeStore';
import { useScenarioStore } from '../telemetry/scenarioStore';
import { useTelemetryBus } from '../telemetry/bus';
import { startScenario, stopScenario, launchScenario } from '../telemetry/scenarioEmitter';

class Element extends EventTarget { tagName = 'DIV'; isContentEditable = false; }
let win: EventTarget;
let detach: () => void;
function key(code: string, up = false, target = win) {
  const event = Object.assign(new Event(up ? 'keyup' : 'keydown', { cancelable: true }), { code, key: code, repeat: false, metaKey: false, altKey: false, isComposing: false });
  target.dispatchEvent(event); return event;
}
beforeEach(() => {
  vi.useFakeTimers();
  win = new EventTarget();
  Object.assign(win, { setInterval, clearInterval });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, visibilityState: 'visible' }));
  vi.stubGlobal('HTMLElement', Element);
  useAppModeStore.setState({ mode: 'MISSION' });
  useScenarioStore.setState({ selectedMission: 'FIRST_DOCKING', startPoint: 'APPROACH' });
  startScenario();
  detach = attachManualControls(new Element() as unknown as HTMLElement);
});
afterEach(() => { detach(); stopScenario(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('prevents expert toggles from wedging guided manual input and Shift really advances the craft', () => {
  launchScenario(); vi.advanceTimersByTime(500);
  for (const code of ['KeyM', 'KeyT', 'KeyG', 'KeyV']) key(code);
  key('ShiftLeft'); vi.advanceTimersByTime(4000); key('ShiftLeft', true);
  const frame = useTelemetryBus.getState().frame!;
  expect(frame.control_mode).toBe('MANUAL'); expect(frame.manual_sub_mode).toBe('RATE');
  expect(frame.manual_authority).toBe('LOW');
  expect(frame.nav_r_hill_m[1]).toBeGreaterThan(-16.25);
});

it('clears held keys on pause, retry and window blur and does not launch from the briefing', () => {
  key('KeyR'); expect(useScenarioStore.getState().phase).toBe('BRIEFING');
  launchScenario(); vi.advanceTimersByTime(500);
  key('ShiftLeft'); key('KeyP');
  const before = useTelemetryBus.getState().frame;
  vi.advanceTimersByTime(3000); expect(useTelemetryBus.getState().frame).toBe(before);
  key('KeyR'); vi.advanceTimersByTime(2000);
  const released = useTelemetryBus.getState().frame;
  key('KeyR'); vi.advanceTimersByTime(2000);
  expect(useTelemetryBus.getState().frame).toEqual(released);
  key('ShiftLeft'); win.dispatchEvent(new Event('blur'));
  expect(useScenarioStore.getState().paused).toBe(true);
});


it('retains a short thrust tap that occurs entirely between input ticks', () => {
  launchScenario(); vi.advanceTimersByTime(500);
  key('KeyJ'); key('KeyJ', true);
  vi.advanceTimersByTime(1500);
  const afterTap = useTelemetryBus.getState().frame!;
  key('KeyR'); vi.advanceTimersByTime(2000);
  const neutral = useTelemetryBus.getState().frame!;
  expect(afterTap.nav_r_hill_m[0]).toBeLessThan(neutral.nav_r_hill_m[0] - 0.001);
});

it('preserves native Space activation on a focused mission button', () => {
  const button = new Element(); button.tagName = 'BUTTON';
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    code: 'Space', key: ' ', repeat: false, metaKey: false, altKey: false, isComposing: false,
  });
  Object.defineProperty(event, 'target', { value: button });
  win.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(useScenarioStore.getState().phase).toBe('BRIEFING');
});

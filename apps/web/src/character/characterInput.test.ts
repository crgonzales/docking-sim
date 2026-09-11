import { expect, it, vi } from 'vitest';
import { CharacterSession } from './characterSession';
import { handleCharacterKeyDown, handleCharacterKeyUp } from './characterInput';

const key = (code: string) => ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, defaultPrevented: false, preventDefault: vi.fn() });
const fixture = () => new CharacterSession({ start: 'GROUND', groundSampler: () => 100 });

it('routes F once and clears character/vehicle holds across a keyboard boarding round trip', () => {
  const s = fixture(); handleCharacterKeyDown(key('KeyW'), s, null);
  handleCharacterKeyDown(key('KeyF'), s, null); expect(s.mode).toBe('VEHICLE');
  handleCharacterKeyDown({ ...key('KeyF'), repeat: true }, s, null); expect(s.mode).toBe('VEHICLE');
  handleCharacterKeyUp(key('KeyF'), s); handleCharacterKeyDown(key('KeyF'), s, null);
  expect(s.mode).toBe('ON_FOOT'); const before = s.position_N_m;
  s.advance(0.1); expect(s.position_N_m).toEqual(before);
  expect(s.flight.controls.pitch).toBe(0);
});

it('leaves forms/buttons and modifiers native, with P/R allowed on flight range/select widgets', () => {
  for (const target of [
    { tagName: 'INPUT', type: 'text', isContentEditable: false },
    { tagName: 'TEXTAREA', isContentEditable: false },
    { tagName: 'BUTTON', isContentEditable: false },
    { tagName: 'SPAN', isContentEditable: true },
  ]) {
    const s = fixture();
    for (const code of ['KeyW', 'KeyF', 'KeyP', 'Digit2']) {
      const event = key(code); handleCharacterKeyDown(event, s, target);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(s.paused).toBe(false); expect(s.equipment).toBe('EMPTY');
  }
  for (const target of [{ tagName: 'INPUT', type: 'range', isContentEditable: false }, { tagName: 'SELECT', isContentEditable: false }]) {
    const s = fixture(), move = key('ArrowUp'); handleCharacterKeyDown(move, s, target);
    expect(move.preventDefault).not.toHaveBeenCalled();
    handleCharacterKeyDown(key('KeyP'), s, target); expect(s.paused).toBe(true);
    handleCharacterKeyDown({ ...key('KeyP'), repeat: true }, s, target); expect(s.paused).toBe(true);
    handleCharacterKeyDown(key('KeyR'), s, target); expect(s.paused).toBe(false);
  }
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented']) {
    const s = fixture(), event = { ...key('KeyF'), [flag]: true };
    handleCharacterKeyDown(event, s, null); expect(event.preventDefault).not.toHaveBeenCalled();
    expect(s.mode).toBe('ON_FOOT');
  }
});

it('ignores equipment repeats and gives the on-foot owner W instead of vehicle pitch', () => {
  const s = fixture(); handleCharacterKeyDown(key('Digit2'), s, null);
  expect(s.equipment).toBe('TOOL');
  handleCharacterKeyDown({ ...key('Digit3'), repeat: true }, s, null); expect(s.equipment).toBe('TOOL');
  const before = s.position_N_m; handleCharacterKeyDown(key('KeyW'), s, null); s.advance(0.1);
  expect(s.position_N_m[0]).toBeGreaterThan(before[0]); expect(s.flight.controls.pitch).toBe(0);
  handleCharacterKeyUp(key('KeyW'), s); const after = s.position_N_m; s.advance(0.1);
  expect(s.position_N_m).toEqual(after);
});

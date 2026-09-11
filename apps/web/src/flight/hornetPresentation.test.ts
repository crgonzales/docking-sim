import { expect, it } from 'vitest';
import { isExcludedHornetPart } from './hornetPresentation';

it('reveals deployed gear only for parked presentation and keeps stores hidden', () => {
  for (const name of ['gear_l', 'gear_r', 'nose_gear', 'nose_gear2', 'gear_l_door1', 'nose_gear_door2']) {
    expect(isExcludedHornetPart(name)).toBe(true);
    expect(isExcludedHornetPart(name, true)).toBe(false);
  }
  for (const name of ['pyl_left', 'tank', 'tank_pyl', 'hook', 'other_door']) {
    expect(isExcludedHornetPart(name)).toBe(true);
    expect(isExcludedHornetPart(name, true)).toBe(true);
  }
  expect(isExcludedHornetPart('fuselage', true)).toBe(false);
});

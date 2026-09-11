/** Deployed source gear bottoms at 2.39 m below the normalized body pivot. */
export const PARKED_HORNET_CLEARANCE_M = 2.4;

/** Preserve the default airborne exclusions; parked mode reveals only the gear assembly. */
export function isExcludedHornetPart(name: string, parked = false): boolean {
  if (parked && /^(gear_[lr]|nose_gear2?)($|_)/i.test(name)) return false;
  return /_door/i.test(name)
    || /^pyl_/i.test(name)
    || /^(gear_l|gear_r|nose_gear|nose_gear2|hook|tank|tank_pyl)$/i.test(name);
}

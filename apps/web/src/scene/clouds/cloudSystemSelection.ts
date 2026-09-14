export type CloudSystemSelection = 'legacy' | 'volumetric';

/**
 * Our volumetric weather renderer is the default cloud system. `legacy` keeps
 * the earlier library cloud backend for deliberate comparisons; the historical
 * `eve` URL value still selects the volumetric system. Missing, empty and
 * unknown values all resolve to the default.
 */
export function resolveCloudSystem(value: string | null | undefined): CloudSystemSelection {
  if (value === 'legacy') return 'legacy';
  return 'volumetric';
}

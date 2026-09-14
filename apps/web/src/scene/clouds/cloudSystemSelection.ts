export type CloudSystemSelection = 'legacy' | 'volumetric';

/** Keep saved diagnostic URLs working while using our own renderer name. */
export function resolveCloudSystem(value: string | null | undefined): CloudSystemSelection {
  return value === 'volumetric' || value === 'eve' ? 'volumetric' : 'legacy';
}

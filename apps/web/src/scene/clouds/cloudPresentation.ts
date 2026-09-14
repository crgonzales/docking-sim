import { Uniform, Vector4 } from 'three';

/** View styling requested for low flight; never changes weather or shadows. */
export function createCloudPresentationUniforms(enabled = true) {
  return {
    volumetricHorizonRangesM: new Uniform(new Vector4(25_000, 100_000, 1500, 8000)),
    volumetricHorizonThinning: new Uniform(enabled ? 0.55 : 0),
  };
}

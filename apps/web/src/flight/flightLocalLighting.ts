import type { SkyLightProbe } from '@takram/three-atmosphere';
import type { LightShadow, Texture, Vector3 } from 'three';

/** The probe stays at scene origin; only its lookup position is in physical metres. */
export function updateFlightSkyProbe(
  probe: SkyLightProbe,
  irradianceTexture: Texture | null,
  positionECEF: Vector3,
  sunDirectionECEF: Vector3,
): boolean {
  probe.irradianceTexture = irradianceTexture;
  if (irradianceTexture === null) {
    // SkyLightProbe.update() otherwise retains the last borrowed LUT's light.
    probe.sh.zero();
    probe.intensity = 0;
    return false;
  }
  probe.position.setScalar(0);
  // SkyLightProbe transposes this basis to rotate SH. Render-metre scale must
  // never enter it, while the translation must include the actual camera eye.
  probe.worldToECEFMatrix.set(
    1, 0, 0, positionECEF.x,
    0, 0, -1, positionECEF.y,
    0, 1, 0, positionECEF.z,
    0, 0, 0, 1,
  );
  probe.sunDirection.copy(sunDirectionECEF);
  probe.intensity = 1;
  probe.update();
  return true;
}

/** Three only allocates a resized shadow target when the old handle is null. */
export function disposeFlightShadowMap(shadow: LightShadow): void {
  const { map, mapPass } = shadow;
  // Clear first so resizing, unmount and StrictMode cleanup are idempotent.
  shadow.map = null;
  shadow.mapPass = null;
  map?.dispose();
  if (mapPass !== map) mapPass?.dispose();
}

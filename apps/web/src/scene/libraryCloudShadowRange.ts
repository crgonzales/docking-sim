import type { CloudsEffect } from '@takram/three-clouds';
import type { PerspectiveCamera } from 'three';
import { EARTH_RADIUS_M, SKY_CONFIG } from './sky/skyConfig';

export interface CloudShadowRangeOptions {
  /** Geometric altitude above the scene's spherical Earth, in metres. */
  cameraAltitudeM: number;
  renderScaleMPerUnit?: number;
  earthRadiusM?: number;
}

export interface CloudShadowRange {
  groundHorizonM: number;
  /** Furthest unoccluded cloud-shell point, including beyond the ground limb. */
  visibleRangeM: number;
  /** Physical bound with room at the edge of the shadow map. */
  maxFarM: number;
  /** Effective view-depth limit, also clipped to the scene camera's far plane. */
  farM: number;
  splitLambda: number;
}

/**
 * Call after quality/weather configuration and before each composer render.
 * Uses only the public CloudsEffect.shadow API in @takram/three-clouds 0.7.6;
 * CloudsEffect.update() rebuilds the actual matrices and atmosphereShadow.far.
 * Does not change camera clipping, map resolution, cascade count or temporal state.
 *
 * The common ground-tangent ray has length sqrt(h * (2R + h)) to the
 * horizon, plus sqrt(H * (2R + H)) out to the cloud top on its far side.
 * A Euclidean range is a conservative camera view-depth bound at any pitch/FOV.
 * Include all active cloud layers (even non-casters that can be seen past the
 * limb). A 5% pad also covers small scene/atmosphere radius differences.
 *
 * Practical splitting targets a first cascade reaching 1.5 camera altitudes
 * when aloft, with a smooth cloud-height floor near the surface. This retains
 * nearby receivers in the detailed cascade despite the camera's 0.5 m near
 * plane. The remaining cascades cover the horizon at necessarily coarser detail.
 * Takram does NOT fade out its last cascade at shadowFar: receivers beyond it
 * can still sample the last map when their UV is valid; outside UV returns zero
 * optical depth. A camera far plane shorter than visibleRangeM, or an extra
 * caller-imposed local cap, therefore needs a separate coverage policy.
 *
 * This is a coverage/resolution fix, NOT a half-float depth fix: ShadowPass
 * writes RGBA16F with R = metres from cloud-ray entry, not camera view depth.
 * Grazing shell paths and the shader's 1e6 m miss sentinel exceed 65504 even
 * with bounded maps. Public maxFar/renderScale cannot normalize that payload.
 */
export function configureCloudShadowRange(
  clouds: CloudsEffect,
  camera: PerspectiveCamera,
  {
    cameraAltitudeM,
    renderScaleMPerUnit = SKY_CONFIG.renderScaleMPerUnit,
    earthRadiusM = EARTH_RADIUS_M,
  }: CloudShadowRangeOptions,
): CloudShadowRange {
  if (!Number.isFinite(cameraAltitudeM)
    || !Number.isFinite(earthRadiusM) || earthRadiusM <= 0
    || !Number.isFinite(renderScaleMPerUnit) || renderScaleMPerUnit <= 0
    || !Number.isFinite(camera.near) || camera.near <= 0
    || !Number.isFinite(camera.far) || camera.far <= camera.near) {
    throw new RangeError('Cloud shadow range requires finite altitude, positive radius/scale and 0 < camera.near < camera.far');
  }
  const count = clouds.shadow.cascadeCount;
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new RangeError('Takram cloud shadows require 1–4 cascades');
  }

  let cloudTopM = 0;
  // CloudLayers is an Array subclass whose filter/map constructors are unsafe.
  for (const layer of clouds.cloudLayers) {
    if (layer.height <= 0 || layer.densityScale <= 0) continue;
    const top = layer.altitude + layer.height;
    if (!Number.isFinite(top)) throw new RangeError('Cloud layer top must be finite');
    cloudTopM = Math.max(cloudTopM, top);
  }
  // A small below-ground/rebase error should behave like sea level.
  const altitudeM = Math.max(0, cameraAltitudeM);
  const groundHorizonM = Math.sqrt(altitudeM * (2 * earthRadiusM + altitudeM));
  const visibleRangeM = groundHorizonM + Math.sqrt(cloudTopM * (2 * earthRadiusM + cloudTopM));
  // Keep a non-degenerate frustum even at sea level with every cloud disabled.
  const maxFarM = Math.max(1.05 * visibleRangeM, 2 * camera.near * renderScaleMPerUnit);
  const maxFar = maxFarM / renderScaleMPerUnit;
  const far = Math.min(maxFar, camera.far);
  const firstFar = Math.hypot(1.5 * altitudeM, cloudTopM) / renderScaleMPerUnit;
  const uniform = camera.near + (far - camera.near) / count;
  const logarithmic = camera.near * (far / camera.near) ** (1 / count);
  const splitLambda = count === 1 ? 0 : Math.max(0, Math.min(1,
    (uniform - firstFar) / (uniform - logarithmic),
  ));
  if (![groundHorizonM, visibleRangeM, maxFarM, maxFar, far, splitLambda].every(Number.isFinite)
    || far <= camera.near) {
    throw new RangeError('Cloud shadow range exceeds finite geometry');
  }

  clouds.shadow.maxFar = maxFar;
  clouds.shadow.farScale = 1;
  clouds.shadow.splitMode = 'practical';
  clouds.shadow.splitLambda = splitLambda;
  return { groundHorizonM, visibleRangeM, maxFarM, farM: far * renderScaleMPerUnit, splitLambda };
}

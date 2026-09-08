import type { CloudsEffect } from '@takram/three-clouds';
import { ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, type Texture } from 'three';
import { createStructuredWeatherTexture, GLOBAL_WEATHER_MAX_WIDTH } from './libraryCloudWeatherField';

export interface GlobalCloudWeatherOptions {
  /** Legacy stays the default until the parent completes visual review. */
  mode?: 'legacy' | 'structured';
  seed?: number;
}

const CUBE_MAPPING = `vec2 getGlobeUv(const vec3 position) {
  return getCubeSphereUv(position);
}`;
const SPHERICAL_MAPPING = `vec2 getGlobeUv(const vec3 position) {
  // Global equirectangular coverage: ECEF longitude, north at v=1.
  if (dot(position.xy, position.xy) == 0.0) {
    return vec2(0.5, position.z < 0.0 ? 0.0 : 1.0);
  }
  return getSphericalUv(position);
}`;
const UV_DERIVATIVES = `  vec2 coord = uv * resolution;
  vec2 ddx = dFdx(coord);
  vec2 ddy = dFdy(coord);`;
const WRAPPED_DERIVATIVES = `  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= round(dx.x);
  dy.x -= round(dy.x);
  vec2 ddx = dx * resolution;
  vec2 ddy = dy * resolution;`;

/** Pinned-library adapter. Both visibility and light transport must sample the
 * same weather location; replacing only the camera pass misregisters shadows. */
export function useGlobalCloudWeather(clouds: CloudsEffect, options: GlobalCloudWeatherOptions = {}): void {
  const materials = [clouds.cloudsPass.currentMaterial, clouds.shadowPass.currentMaterial];
  for (const material of materials) {
    if (material.fragmentShader.split(CUBE_MAPPING).length !== 2
      || material.fragmentShader.split(UV_DERIVATIVES).length !== 2) {
      throw new Error('Pinned Takram cloud mapping changed; review global weather adapter');
    }
  }
  for (const material of materials) {
    material.fragmentShader = material.fragmentShader.replace(CUBE_MAPPING, SPHERICAL_MAPPING)
      .replace(UV_DERIVATIVES, WRAPPED_DERIVATIVES);
    material.needsUpdate = true;
  }
  clouds.localWeatherRepeat.set(1, 1);
  clouds.localWeatherOffset.set(0, 0);
  clouds.coverage = 0.5;
  if (options.mode === 'structured') {
    // Larger primary formations; retain the existing fine erosion texture.
    clouds.shapeRepeat.setScalar(0.0001);
    clouds.localWeatherVelocity.set(0, 0);
    clouds.shapeVelocity.set(0, 0, 0); clouds.shapeDetailVelocity.set(0, 0, 0);
    clouds.shapeOffset.set(0, 0, 0); clouds.shapeDetailOffset.set(0, 0, 0);
    clouds.cloudLayers.reset().set([
      { channel: 'r', altitude: 1000, height: 1600, densityScale: 0.1,
        shapeAmount: 0.6, shapeDetailAmount: 0.5, coverageFilterWidth: 0.5,
        weatherExponent: 1, shapeAlteringBias: 0.4, shadow: true,
        densityProfile: { expTerm: 0, exponent: 0, linearTerm: -0.45, constantTerm: 0.9 } },
      { channel: 'g', altitude: 1400, height: 4200, densityScale: 0.12,
        shapeAmount: 0.65, shapeDetailAmount: 0.5, coverageFilterWidth: 0.5,
        weatherExponent: 1, shapeAlteringBias: 0.3, shadow: true,
        densityProfile: { expTerm: 0, exponent: 0, linearTerm: 0.6, constantTerm: 0.3 } },
      { channel: 'b', altitude: 7500, height: 600, densityScale: 0.003,
        shapeAmount: 0.2, shapeDetailAmount: 0, coverageFilterWidth: 0.5,
        weatherExponent: 1, shapeAlteringBias: 0.5, shadow: false,
        densityProfile: { expTerm: 0, exponent: 0, linearTerm: -0.2, constantTerm: 0.6 } },
      { channel: 'a' },
    ]);
    return;
  }
  // Use coverage as a weather envelope, with metre-scale 3D shape inside it.
  // C + filterWidth = 1 keeps zero-valued weather exactly clear at all heights.
  clouds.cloudLayers.reset().set([
    { channel: 'r', altitude: 1000, height: 2000, densityScale: 0.12,
      shapeAmount: 0.6, shapeDetailAmount: 0.5, coverageFilterWidth: 0.5,
      weatherExponent: 1, shapeAlteringBias: 0.35, shadow: true },
    { channel: 'r', altitude: 7500, height: 500, densityScale: 0.003,
      shapeAmount: 0.2, shapeDetailAmount: 0, coverageFilterWidth: 0.5,
      weatherExponent: 2, shapeAlteringBias: 0.35, shadow: false },
  ]);
}

/** Pass the same mode to this loader adapter and useGlobalCloudWeather.
 * Structured returns a new caller-owned texture; the source remains owned by
 * the caller. Call once after loading, never in the frame loop. */
export function configureGlobalWeatherTexture(texture: Texture, options: GlobalCloudWeatherOptions = {}): Texture {
  if (options.mode === 'structured') {
    const image = texture.image as HTMLImageElement;
    const width = image?.naturalWidth ?? image?.width, height = image?.naturalHeight ?? image?.height;
    if (!(width >= 4) || width !== height * 2) throw new Error('Global weather requires a loaded 2:1 image');
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(width, GLOBAL_WEATHER_MAX_WIDTH); canvas.height = canvas.width / 2;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Global weather coverage readback unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    texture = createStructuredWeatherTexture({ data, width: canvas.width, height: canvas.height, channels: 4 }, options.seed);
    canvas.width = canvas.height = 0;
  }
  texture.colorSpace = NoColorSpace; // The existing mask already stores coverage.
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping; // North and south poles never wrap together.
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = !texture.mipmaps?.length;
  texture.needsUpdate = true;
  return texture;
}

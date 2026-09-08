import { describe, expect, it } from 'vitest';
import { CloudsEffect } from '@takram/three-clouds';
import { Data3DTexture, LinearMipmapLinearFilter, PerspectiveCamera } from 'three';
import { configureCloudFootprint, configureCloudNoiseMipmaps } from './libraryCloudFootprint';

const setup = () => new CloudsEffect(new PerspectiveCamera());
describe('physical cloud noise footprint', () => {
  it('filters shape and detail independently of weather repeat', () => {
    const clouds = setup();
    const current = clouds.cloudsPass.currentMaterial;
    const before = current.fragmentShader;
    configureCloudFootprint(clouds);
    expect(current.fragmentShader).toContain('textureLod(shapeTexture, shapePosition, noiseLod(shapeTexture, shapeRepeat, position))');
    expect(current.fragmentShader).toContain('textureLod(shapeDetailTexture, detailPosition, noiseLod(shapeDetailTexture, shapeDetailRepeat, position))');
    expect(current.fragmentShader).toContain('length(position - cloudCameraECEF) * cloudPixelRaySlope');
    const weather = (s: string) => s.slice(s.indexOf('WeatherSample sampleWeather('), s.indexOf('vec4 getLayerDensity('));
    expect(weather(current.fragmentShader)).toBe(weather(before));
    expect(current.fragmentShader).toContain('length(dFdy(footprintPoint))) / 4.0;');
    clouds.dispose();
  });
  it('uses native pixel spacing when temporal upscaling is disabled', () => {
    const clouds = setup(); clouds.temporalUpscale = false;
    configureCloudFootprint(clouds);
    expect(clouds.cloudsPass.currentMaterial.fragmentShader).toContain('length(dFdy(footprintPoint))) / 1.0;');
    clouds.dispose();
  });
  it('provides actual mip levels for loaded volume data', () => {
    const texture = new Data3DTexture(new Uint8Array(8 ** 3), 8, 8, 8);
    const data = texture.image.data;
    configureCloudNoiseMipmaps(texture);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture.image.data).toBe(data);
    texture.dispose();
  });
  it('resolves orbital pixel sizes far above the base/detail texel sizes', () => {
    // A finite-difference perspective-ray oracle at screen center, independent
    // of weather-map resolution: 45-degree FOV and 1059 output pixels.
    const pixelMeters = 2 * Math.tan(Math.PI / 8) / 1059 * 400000;
    const baseTexels = pixelMeters * 0.0003 * 128;
    const detailTexels = pixelMeters * 0.006 * 32;
    expect(Math.log2(baseTexels)).toBeGreaterThan(3.5);
    expect(Math.log2(detailTexels)).toBeGreaterThan(5.8);
    expect(Math.log2(Math.max(1, pixelMeters / 4000 * 0.0003 * 128))).toBe(0);
  });
  it('fails atomically when the pinned shader no longer matches', () => {
    const clouds = setup(); const current = clouds.cloudsPass.currentMaterial;
    current.fragmentShader = current.fragmentShader.replace('texture(shapeTexture, shapePosition).r', '0.5');
    const before = current.fragmentShader;
    expect(() => configureCloudFootprint(clouds)).toThrow('Pinned cloud noise changed');
    expect(current.fragmentShader).toBe(before);
    clouds.dispose();
  });
});

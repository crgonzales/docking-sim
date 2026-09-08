import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudsEffect } from '@takram/three-clouds';
import { ClampToEdgeWrapping, DataTexture, LinearFilter, LinearMipmapLinearFilter,
  NoColorSpace, PerspectiveCamera, RepeatWrapping, Texture } from 'three';
import { configureGlobalWeatherTexture, useGlobalCloudWeather } from './libraryCloudWeather';
import { createStructuredWeatherTexture } from './libraryCloudWeatherField';

afterEach(() => vi.unstubAllGlobals());

describe('global cloud weather adapter', () => {
  it('uses the same spherical field for camera, secondary light and shadow marches', () => {
    const clouds = new CloudsEffect();
    try {
      useGlobalCloudWeather(clouds);
      for (const material of [clouds.cloudsPass.currentMaterial, clouds.shadowPass.currentMaterial]) {
        expect(material.fragmentShader).toContain('return getSphericalUv(position);');
        expect(material.fragmentShader).not.toContain('return getCubeSphereUv(position);');
        // Pin the actual installed mapping as well as the selected wrapper.
        expect(material.fragmentShader).toContain('phi * RECIPROCAL_PI2 + 0.5, theta * RECIPROCAL_PI + 0.5');
      }
      expect(clouds.localWeatherRepeat.toArray()).toEqual([1, 1]);
      expect(Array.from(clouds.cloudLayers).filter(layer => layer.height > 0)).toHaveLength(2);
      expect(Array.from(clouds.cloudLayers).filter(layer => layer.height > 0).every(layer => layer.channel === 'r')).toBe(true);
    } finally { clouds.dispose(); }
  });
  it('rejects upstream mapping changes before partially patching either pass', () => {
    const clouds = new CloudsEffect();
    try {
      const original = clouds.cloudsPass.currentMaterial.fragmentShader;
      clouds.shadowPass.currentMaterial.fragmentShader = 'incompatible';
      expect(() => useGlobalCloudWeather(clouds)).toThrow('Pinned Takram cloud mapping changed');
      expect(clouds.cloudsPass.currentMaterial.fragmentShader).toBe(original);
    } finally { clouds.dispose(); }
  });
  it.each(['legacy', 'structured'] as const)('keeps clear weather empty at every layer height (%s)', mode => {
    const clouds = new CloudsEffect();
    try {
      useGlobalCloudWeather(clouds, { mode });
      for (const layer of Array.from(clouds.cloudLayers).filter(layer => layer.height > 0)) {
        // Installed sampleWeather remap at zero input: this inequality is a
        // necessary empty-space invariant, including its peak height envelope.
        expect(clouds.coverage + layer.coverageFilterWidth).toBeLessThanOrEqual(1);
        expect(layer.weatherExponent).toBeGreaterThan(0);
        for (const heightScale of [0, 0.25, 0.5, 0.75, 1]) {
          const density = Math.max(0, (layer.coverageFilterWidth - (1 - clouds.coverage * heightScale)) / layer.coverageFilterWidth);
          expect(density).toBe(0);
        }
      }
    } finally { clouds.dispose(); }
  });
  it('treats the grayscale asset as data, wrapping longitude but clamping latitude', () => {
    const texture = configureGlobalWeatherTexture(new Texture());
    try {
      expect(texture.colorSpace).toBe(NoColorSpace);
      expect(texture.wrapS).toBe(RepeatWrapping);
      expect(texture.wrapT).toBe(ClampToEdgeWrapping);
      expect(texture.flipY).toBe(true); // north-at-top PNG becomes v=1.
      expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
      expect(texture.magFilter).toBe(LinearFilter);
      expect(texture.generateMipmaps).toBe(true);
    } finally { texture.dispose(); }
  });

  it('bakes the loaded image once at bounded size, without modifying or disposing the source', () => {
    const source = new Texture({ naturalWidth: 2048, naturalHeight: 1024 } as HTMLImageElement);
    const dispose = vi.spyOn(source, 'dispose');
    const data = new Uint8ClampedArray(1024 * 512 * 4);
    for (let i = 0; i < data.length; i += 4) data[i] = 200;
    const context = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data })) };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    const texture = configureGlobalWeatherTexture(source, { mode: 'structured', seed: 123 });
    try {
      expect(texture).toBeInstanceOf(DataTexture); expect(texture).not.toBe(source);
      expect(texture.image.width).toBe(1024); expect(texture.image.height).toBe(512);
      expect(texture.name).toBe('global-weather-structured-123');
      expect(context.drawImage).toHaveBeenCalledOnce();
      expect(context.drawImage).toHaveBeenCalledWith(source.image, 0, 0, 1024, 512);
      expect(context.getImageData).toHaveBeenCalledOnce();
      expect(context.getImageData).toHaveBeenCalledWith(0, 0, 1024, 512);
      expect(source.version).toBe(0); expect(dispose).not.toHaveBeenCalled();
      expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    } finally { texture.dispose(); source.dispose(); }
  });

  it('fails explicitly on missing pixels or unavailable readback', () => {
    expect(() => configureGlobalWeatherTexture(new Texture(), { mode: 'structured' })).toThrow('loaded 2:1');
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    expect(() => configureGlobalWeatherTexture(new Texture({ width: 4, height: 2 } as HTMLImageElement),
      { mode: 'structured' })).toThrow('readback unavailable');
  });

  it('pins actual installed channel swizzles, shared density uniforms and the camera/light/shadow shader contract', () => {
    const source = (file: string) => readFileSync(new URL(`../../node_modules/@takram/three-clouds/${file}`, import.meta.url), 'utf8');
    expect(JSON.parse(source('package.json')).version).toBe('0.7.6');
    const camera = new PerspectiveCamera(); camera.position.set(6400000, 0, 0); camera.updateMatrixWorld();
    const clouds = new CloudsEffect(camera);
    const texture = createStructuredWeatherTexture({ width: 8, height: 4, channels: 1, data: new Uint8Array(32).fill(255) });
    try {
      clouds.localWeatherVelocity.set(2, 3); clouds.shapeVelocity.set(1, 2, 3); clouds.shapeDetailVelocity.set(3, 2, 1);
      useGlobalCloudWeather(clouds, { mode: 'structured' });
      clouds.localWeatherTexture = texture;
      // Exercise installed JS packing/define propagation without a GPU/render.
      const internal = clouds as unknown as { updateSharedUniforms(dt: number): void; updateWeatherTextureChannels(): void };
      internal.updateSharedUniforms(10); internal.updateWeatherTextureChannels();
      const cameraMaterial = clouds.cloudsPass.currentMaterial, shadowMaterial = clouds.shadowPass.currentMaterial;
      for (const material of [cameraMaterial, shadowMaterial]) {
        expect(material.defines.LOCAL_WEATHER_CHANNELS).toBe('rgba');
        expect(material.uniforms.localWeatherTexture.value).toBe(texture);
        for (const name of ['localWeatherTexture', 'localWeatherRepeat', 'localWeatherOffset', 'worldToECEFMatrix',
          'minLayerHeights', 'maxLayerHeights', 'densityProfile'] as const) {
          expect(material.uniforms[name]).toBe(cameraMaterial.uniforms[name]);
        }
        expect(material.fragmentShader).toContain(').LOCAL_WEATHER_CHANNELS');
        expect(material.fragmentShader).toContain('mix(localWeather, vec4(1.0), coverageFilterWidths)');
        expect(material.fragmentShader).toContain('densityProfile.linearTerms * heightFraction +');
        expect(material.fragmentShader).toContain('density = saturate(density * densityScales * getLayerDensity(weather.heightFraction));');
        expect(material.fragmentShader).toContain('dot(position.xy, position.xy) == 0.0');
        expect(material.fragmentShader).toContain('dx.x -= round(dx.x);');
        expect(material.fragmentShader).toContain('dy.x -= round(dy.x);');
      }
      expect(cameraMaterial.vertexShader).toContain('(worldToECEFMatrix * vec4(cameraPosition, 1.0)).xyz');
      expect(shadowMaterial.fragmentShader).toContain('(worldToECEFMatrix * vec4(point.xyz, 1.0)).xyz');
      // Both primary and secondary marches use this same weather function.
      expect(cameraMaterial.fragmentShader.match(/WeatherSample weather = sampleWeather\(uv, height, mipLevel\);/g)).toHaveLength(2);
      expect(shadowMaterial.fragmentShader.match(/WeatherSample weather = sampleWeather\(uv, height, mipLevel\);/g)).toHaveLength(1);
      expect(shadowMaterial.uniforms.shadowLayerMask.value.toArray()).toEqual([1, 1, 0, 0]);
      expect(cameraMaterial.uniforms.minLayerHeights.value.toArray()).toEqual([1000, 1400, 7500, 0]);
      expect(cameraMaterial.uniforms.maxLayerHeights.value.toArray()).toEqual([2600, 5600, 8100, 0]);
      expect(cameraMaterial.uniforms.densityProfile.value.linearTerms.toArray().slice(0, 3)).toEqual([-0.45, 0.6, -0.2]);
      expect(clouds.localWeatherOffset.toArray()).toEqual([0, 0]);
      expect(clouds.shapeOffset.toArray()).toEqual([0, 0, 0]); expect(clouds.shapeDetailOffset.toArray()).toEqual([0, 0, 0]);
      for (const layer of Array.from(clouds.cloudLayers).filter(layer => layer.height > 0)) {
        for (const h of [0, 0.25, 0.5, 0.75, 1]) {
          const p = layer.densityProfile;
          const density = p.expTerm * Math.exp(p.exponent * h) + p.linearTerm * h + p.constantTerm;
          expect(density).toBeGreaterThan(0); expect(density).toBeLessThanOrEqual(1);
        }
      }
    } finally { clouds.dispose(); texture.dispose(); }
  });

  it('rejects a changed derivative anchor before mutating either pass', () => {
    const clouds = new CloudsEffect();
    try {
      const original = clouds.cloudsPass.currentMaterial.fragmentShader;
      clouds.shadowPass.currentMaterial.fragmentShader = clouds.shadowPass.currentMaterial.fragmentShader.replace('vec2 coord = uv * resolution;', 'changed');
      expect(() => useGlobalCloudWeather(clouds, { mode: 'structured' })).toThrow('Pinned Takram');
      expect(clouds.cloudsPass.currentMaterial.fragmentShader).toBe(original);
    } finally { clouds.dispose(); }
  });
});

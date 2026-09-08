import { afterEach, describe, expect, it } from 'vitest';
import { CloudsEffect } from '@takram/three-clouds';
import { configureCloudSampling } from './libraryCloudSampling';

interface Settings {
  minStepSize: number; maxStepSize: number; perspectiveStepScale: number; maxIterationCount: number;
}
const layers = [
  { altitude: 1000, height: 2000, densityScale: 0.2 },
  { altitude: 7500, height: 500, densityScale: 0.003 },
];
const ORIGINAL = '  float stepSize = minStepSize + (perspectiveStepScale - 1.0) * rayNearFar.x;';
const REPLACEMENT = '  float stepSize = minStepSize; // Start sampling at the cloud boundary.';
const disposables: CloudsEffect[] = [];
afterEach(() => disposables.splice(0).forEach(clouds => clouds.dispose()));
function effect(preset: 'low' | 'medium' = 'low') {
  const clouds = new CloudsEffect();
  disposables.push(clouds);
  clouds.qualityPreset = preset;
  for (const layer of Array.from(clouds.cloudLayers)) layer.set({ height: 0, densityScale: 0 });
  layers.forEach((layer, i) => clouds.cloudLayers[i].set(layer));
  return clouds;
}
function settings(clouds: CloudsEffect): Settings {
  const { minStepSize, maxStepSize, perspectiveStepScale, maxIterationCount } = clouds.clouds;
  return { minStepSize, maxStepSize, perspectiveStepScale, maxIterationCount };
}

// Independent analytical ray/sphere oracle, in the corrected 6360 km cloud frame.
// Model the stock above-cloud and inside-envelope branches used by these cases.
const radius = 6360000;
function ray(height: number, angle: number) {
  const r = radius + height, dot = -r * Math.cos(angle * Math.PI / 180);
  function roots(shellHeight: number) {
    const discriminant = dot * dot - r * r + (radius + shellHeight) ** 2;
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    return [-dot - root, -dot + root];
  }
  const outer = roots(8000)!;
  const near = height < 8000 ? 0.5 : outer[0];
  const far = roots(0) ? roots(1000)![0] : outer[1];
  return {
    near, span: far - near, lowerDeckEntry: roots(3000)?.[0]! - near,
    heightAt: (distance: number) => Math.sqrt(r * r + 2 * dot * (near + distance) + (near + distance) ** 2) - radius,
  };
}

// CPU geometry/schedule model, not GPU radiance. No extinction early-out or
// weather/erosion holes. 'distance' uses the installed mip equation with a
// rayStartTexelsPerPixel of 1 (initial mip zero), allowing later mip growth.
function march(height: number, angle: number, jitter: number, mip: number | 'distance', config: Settings, boundaryStart = true) {
  const path = ray(height, angle);
  let step = config.minStepSize + (boundaryStart ? 0 : (config.perspectiveStepScale - 1) * path.near);
  let distance = step * jitter * 2;
  const samples: number[] = [], advances: number[] = [];
  for (let i = 0; i < config.maxIterationCount && distance <= path.span; ++i) {
    const h = path.heightAt(distance);
    samples.push(h);
    const occupied = layers.some(layer => h > layer.altitude && h < layer.altitude + layer.height);
    const lod = mip === 'distance' ? Math.log2(Math.max(1, 1 + distance * 1e-5)) : mip;
    step *= config.perspectiveStepScale;
    const advance = occupied ? step : step + (config.maxStepSize - step) * Math.min(1, lod);
    advances.push(advance);
    distance += advance;
  }
  return { samples, advances, reachedM: distance, finished: distance > path.span };
}

describe('cloud-boundary initial step with preset adaptive growth', () => {
  it.each(['low', 'medium'] as const)('patches %s once, preserving all other shader source, shadows, minStepSize and growth', preset => {
    const clouds = effect(preset);
    const primary = clouds.cloudsPass.currentMaterial, shadow = clouds.shadowPass.currentMaterial;
    const before = settings(clouds);
    const shader = primary.fragmentShader, shadowShader = shadow.fragmentShader;
    const shadowStep = clouds.shadow.maxStepSize, version = primary.version;
    expect(shader.split(ORIGINAL)).toHaveLength(2);
    expect(before.perspectiveStepScale).toBe(1.01);
    configureCloudSampling(clouds);
    expect(settings(clouds)).toEqual({ ...before, maxStepSize: 250, maxIterationCount: 500 });
    expect(primary.uniforms.perspectiveStepScale.value).toBe(1.01);
    expect(primary.uniforms.maxStepSize.value).toBe(250);
    expect(primary.uniforms.maxIterationCount.value).toBe(500);
    expect(primary.fragmentShader).toBe(shader.replace(ORIGINAL, REPLACEMENT));
    expect(primary.version).toBe(version + 1);
    expect(shadow.fragmentShader).toBe(shadowShader);
    expect(clouds.shadow.maxStepSize).toBe(shadowStep);
    const patched = primary.fragmentShader, configured = settings(clouds);
    expect(() => configureCloudSampling(clouds)).toThrow('Pinned Takram cloud march changed');
    expect(primary.fragmentShader).toBe(patched);
    expect(primary.version).toBe(version + 1);
    expect(settings(clouds)).toEqual(configured);
  });

  it.each(['missing', 'duplicate'])('rejects a %s initial-step expression before mutation', mode => {
    const clouds = effect();
    const material = clouds.cloudsPass.currentMaterial;
    material.fragmentShader = mode === 'missing'
      ? material.fragmentShader.replace(ORIGINAL, '') : material.fragmentShader + ORIGINAL;
    const before = settings(clouds), shader = material.fragmentShader, version = material.version;
    expect(() => configureCloudSampling(clouds)).toThrow('Pinned Takram cloud march changed');
    expect(settings(clouds)).toEqual(before);
    expect(material.fragmentShader).toBe(shader);
    expect(material.version).toBe(version);
  });

  it('ignores disabled/zero-height layers without the CloudLayers.filter species trap', () => {
    const clouds = effect();
    clouds.cloudLayers[2].set({ height: 1, densityScale: 0 });
    clouds.cloudLayers[3].set({ height: 0, densityScale: 0.2 });
    configureCloudSampling(clouds);
    expect(clouds.clouds.maxStepSize).toBe(250);
    const thin = effect();
    thin.cloudLayers[2].set({ height: 1, densityScale: 0.2 });
    configureCloudSampling(thin);
    expect(thin.clouds.maxStepSize).toBe(0.5);
  });

  it('preserves smaller existing skips, larger budgets, caller minStepSize and adaptive growth', () => {
    const clouds = effect();
    Object.assign(clouds.clouds, { maxStepSize: 80, minStepSize: 40, maxIterationCount: 750, perspectiveStepScale: 1.005 });
    configureCloudSampling(clouds);
    expect(settings(clouds)).toEqual({ minStepSize: 40, maxStepSize: 80, perspectiveStepScale: 1.005, maxIterationCount: 750 });
  });

  it('retains maxStepSize when no layers are active', () => {
    const clouds = effect();
    for (const layer of Array.from(clouds.cloudLayers)) layer.densityScale = 0;
    const before = clouds.clouds.maxStepSize;
    configureCloudSampling(clouds);
    expect(clouds.clouds.maxStepSize).toBe(before);
  });

  it('pins the installed schedule and reproduces the old 4020 m initial-step miss', () => {
    const clouds = effect();
    const shader = clouds.cloudsPass.currentMaterial.fragmentShader;
    for (const source of [ORIGINAL, 'float rayDistance = stepSize * jitter * 2.0;',
      'rayDistance += mix(stepSize, maxStepSize, min(1.0, mipLevel));',
      'stepSize *= perspectiveStepScale;', 'float maxRayDistance = rayNearFar.y - rayNearFar.x;',
      'float mipLevel = log2(max(1.0, rayStartTexelsPerPixel + rayDistance * 1e-5));',
    ]) expect(shader).toContain(source);
    const legacy = settings(clouds);
    expect(legacy.minStepSize + (legacy.perspectiveStepScale - 1) * ray(400000, 0).near).toBeCloseTo(4020, 8);
    expect(ray(400000, 0).span).toBe(7000);
    expect(march(400000, 0, 0.99, 0, legacy, false).samples).toHaveLength(0);
    configureCloudSampling(clouds);
    expect(march(400000, 0, 0.99, 0, settings(clouds)).samples[0]).toBeCloseTo(7802, 6);
  });

  it.each([0, 30, 45, 60])('places the first sample inside the 500 m top layer at 400 km/%i degrees', angle => {
    for (const preset of ['low', 'medium'] as const) {
      const clouds = effect(preset);
      configureCloudSampling(clouds);
      const config = settings(clouds), path = ray(400000, angle);
      for (const jitter of [0.01, 0.25, 0.5, 0.99, 1]) {
        const firstDistance = 2 * config.minStepSize * jitter;
        expect(firstDistance).toBeLessThan(500);
        expect(path.heightAt(firstDistance)).toBeGreaterThan(7500);
        expect(path.heightAt(firstDistance)).toBeLessThan(8000);
      }
      // Jitter zero lies on the outer boundary; the next advance enters the layer.
      expect(path.heightAt(config.minStepSize * config.perspectiveStepScale)).toBeGreaterThan(7500);
      expect(path.heightAt(config.minStepSize * config.perspectiveStepScale)).toBeLessThan(8000);
    }
  });

  it('improves reach at 17 km on a grazing ray without claiming full limb coverage', () => {
    const clouds = effect('medium');
    configureCloudSampling(clouds);
    const adaptive = settings(clouds), constant = { ...adaptive, perspectiveStepScale: 1 };
    // Perigee is 2 km: 3.93 degrees below horizontal, shallower than the
    // parent's GPU-confirmed -10 degree view whose hard cutoff is now gone.
    const angle = Math.asin((radius + 2000) / (radius + 17000)) * 180 / Math.PI;
    const path = ray(17000, angle);
    const old = march(17000, angle, 0.5, 'distance', constant);
    const updated = march(17000, angle, 0.5, 'distance', adaptive);
    expect(path.span).toBeCloseTo(552738.636, 2);
    expect(old.reachedM).toBeCloseTo(42167.616, 2);
    expect(updated.reachedM).toBeCloseTo(129552.592, 2);
    expect(updated.reachedM).toBeGreaterThan(old.reachedM * 3);
    // Concrete remaining counterexample: the lower deck starts beyond both
    // budgets. At mip >= 1, empty-space advances remain fixed at maxStepSize.
    expect(path.lowerDeckEntry).toBeCloseTo(163564.176, 2);
    expect(updated.reachedM).toBeLessThan(path.lowerDeckEntry);
    expect(old.finished).toBe(false);
    expect(updated.finished).toBe(false);
    // maxStepSize is an empty-space target, not a cap on adaptive advances.
    expect(Math.max(...updated.advances)).toBeGreaterThan(adaptive.maxStepSize);
  });

  it('starts at cameraNear inside the envelope at 7 km and reaches the lower deck looking down 10 degrees', () => {
    const clouds = effect('medium');
    configureCloudSampling(clouds);
    const path = ray(7000, 80);
    expect(path.near).toBe(0.5);
    for (const mip of [0, 1, 'distance'] as const) {
      const result = march(7000, 80, 0.5, mip, settings(clouds));
      expect(result.samples[0]).toBeGreaterThan(3000); // Starts in the inter-layer gap.
      expect(result.samples[0]).toBeLessThan(7000);
      expect(result.samples.some(height => height > 1000 && height < 3000)).toBe(true);
      expect(result.finished).toBe(true);
    }
  });
});

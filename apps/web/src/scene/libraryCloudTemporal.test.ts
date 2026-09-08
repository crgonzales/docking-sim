import { describe, expect, it } from 'vitest';
import { CloudsEffect } from '@takram/three-clouds';
import { DataUtils, PerspectiveCamera } from 'three';
import { configureCloudTemporal } from './libraryCloudTemporal';
import { CAMERA_FAR } from './sky/skyConfig';

const effect = () => new CloudsEffect(new PerspectiveCamera(45, 1, 0.5, CAMERA_FAR));
const half = (value: number) => DataUtils.fromHalfFloat(DataUtils.toHalfFloat(value));

describe('cloud history depth and accumulation', () => {
  it('stores the complete camera envelope in half precision with finite ordered distances', () => {
    const distances = [0.5, 50, 1000, 65504, 70000, 400000, 12000000, CAMERA_FAR];
    const stored = distances.map(value => half(value * 1e-4));
    expect(CAMERA_FAR).toBeLessThan(65504 / 1e-4);
    expect(400000).toBeGreaterThan(65504);
    for (let i = 0; i < stored.length; ++i) {
      expect(Number.isFinite(stored[i])).toBe(true);
      expect(Math.abs(stored[i] / 1e-4 - distances[i]) / distances[i]).toBeLessThan(0.002);
      if (i) expect(stored[i]).toBeGreaterThan(stored[i - 1]);
    }
  });
  it('changes both cloud-hit and clear-ray depth writes without scaling UV velocity', () => {
    const clouds = effect();
    configureCloudTemporal(clouds);
    const shader = clouds.cloudsPass.currentMaterial.fragmentShader;
    expect(shader.split('depthVelocity = vec3(frontDepth * 1e-4, velocity);')).toHaveLength(3);
    expect(shader).not.toContain('depthVelocity = vec3(frontDepth, velocity);');
    expect(shader).toContain('outputDepthVelocity = depthVelocity;');
    clouds.dispose();
  });
  it('accumulates new Bayer samples and retains viewport rejection and variance clipping', () => {
    const clouds = effect();
    configureCloudTemporal(clouds, true);
    const shader = clouds.cloudsPass.resolveMaterial.fragmentShader;
    expect(shader).not.toContain('// Use the texel just rendered without any accumulation.');
    expect(shader).toContain('currentFrame ? mix(clippedColor, currentColor, temporalAlpha) : clippedColor');
    expect(shader).toContain('if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0)');
    expect(shader).toContain('varianceClipping(colorBuffer, vUv, currentColor, historyColor, varianceGamma)');
    expect(clouds.cloudsPass.resolveMaterial.uniforms.temporalAlpha.value).toBe(0.25);
    clouds.dispose();
  });
  it('rejects upstream shader changes atomically', () => {
    const clouds = effect();
    const current = clouds.cloudsPass.currentMaterial;
    const resolve = clouds.cloudsPass.resolveMaterial;
    resolve.fragmentShader = resolve.fragmentShader.replace('  outputColor = clippedColor;', '  outputColor = currentColor;');
    const before = current.fragmentShader;
    expect(() => configureCloudTemporal(clouds)).toThrow('Pinned cloud temporal shader changed');
    expect(current.fragmentShader).toBe(before);
    clouds.dispose();
  });
  it('guards against accidentally applying the patch twice', () => {
    const clouds = effect();
    configureCloudTemporal(clouds);
    expect(() => configureCloudTemporal(clouds)).toThrow('Pinned cloud temporal shader changed');
    clouds.dispose();
  });
});

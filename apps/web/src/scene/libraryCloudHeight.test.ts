import { describe, expect, it } from 'vitest';
import { CloudsEffect } from '@takram/three-clouds';
import { Geodetic } from '@takram/three-geospatial';
import { Vector3 } from 'three';
import { stabilizeCloudHeight } from './libraryDepth';
describe('cloud layer classification uses the cloud intersection sphere', () => {
  it('patches the installed fragment shader once, before intersection classification', () => {
    const clouds = new CloudsEffect();
    try {
      stabilizeCloudHeight(clouds);
      const shader = clouds.cloudsPass.currentMaterial.fragmentShader;
      expect(shader).not.toContain('uniform float cameraHeight;');
      expect(shader).toContain('cameraHeight = length(cameraPosition) - bottomRadius;');
      expect(shader.indexOf('cameraHeight = length(cameraPosition)')).toBeLessThan(shader.indexOf('IntersectionResult intersections = getIntersections(cameraPosition'));
      expect(() => stabilizeCloudHeight(clouds)).toThrow('Pinned Takram depth shader changed');
    } finally { clouds.dispose(); }
  });
  it.each([50, 750, 1500, 2500, 3000, 8000])('classifies %i m using the same radius as the ray intersections', height => {
    const lat = 28.6 * Math.PI / 180, lon = -79.6 * Math.PI / 180;
    const up = new Vector3(Math.cos(lat)*Math.cos(lon), Math.cos(lat)*Math.sin(lon), Math.sin(lat));
    const originalECEF = up.clone().multiplyScalar(6371000 + height);
    const wrong = new Geodetic().setFromECEF(originalECEF).height;
    expect(wrong - height).toBeLessThan(-2200);
    const corrected = originalECEF.addScaledVector(up, 6360000 - 6371000);
    expect(corrected.length() - 6360000).toBeCloseTo(height, 6);
    if (height === 2500) {
      expect(wrong).toBeLessThan(750); // Wrongly selects "below all clouds".
      expect(height).toBeGreaterThan(2200); // Actually above both lower cloud layers.
    }
  });
});

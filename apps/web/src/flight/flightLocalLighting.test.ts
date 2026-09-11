import { describe, expect, it } from 'vitest';
import { AtmosphereParameters, SkyLightProbe } from '@takram/three-atmosphere';
import { Ellipsoid } from '@takram/three-geospatial';
import { DataTexture, DirectionalLight, FloatType, Matrix3, RGBAFormat, Vector3, WebGLRenderTarget } from 'three';
import { EARTH_RADIUS_M } from '../scene/sky/skyConfig';
import { disposeFlightShadowMap, updateFlightSkyProbe } from './flightLocalLighting';

describe('local atmosphere sky illumination', () => {
  it('preserves irradiance and radial orientation at different locations and camera heights', () => {
    // A constant LUT isolates the production library SH projection from weather.
    const texture = new DataTexture(new Float32Array([0.01, 0.02, 0.03, 1]), 1, 1, RGBAFormat, FloatType);
    const probe = new SkyLightProbe({ ellipsoid: new Ellipsoid(EARTH_RADIUS_M, EARTH_RADIUS_M, EARTH_RADIUS_M) });
    const expected = new Vector3(0.01, 0.02, 0.03).multiply(AtmosphereParameters.DEFAULT.skyRadianceToRelativeLuminance);
    for (const radial of [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(1, 2, -3).normalize()]) {
      for (const altitude of [2, 3000, 400_000]) {
        const position = radial.clone().multiplyScalar(EARTH_RADIUS_M + altitude);
        expect(updateFlightSkyProbe(probe, texture, position, radial)).toBe(true);
        const rotation = new Matrix3().setFromMatrix4(probe.worldToECEFMatrix);
        expect(rotation.determinant()).toBeCloseTo(1, 12);
        const up = new Vector3(radial.x, radial.z, -radial.y);
        const sky = probe.sh.getIrradianceAt(up, new Vector3());
        const underside = probe.sh.getIrradianceAt(up.clone().negate(), new Vector3());
        for (let channel = 0; channel < 3; channel++) {
          // Three uses rounded SH constants; this is the analytic hemisphere oracle.
          expect(sky.getComponent(channel)).toBeCloseTo(expected.getComponent(channel), 5);
          expect(Math.abs(underside.getComponent(channel))).toBeLessThan(1e-5);
        }
      }
    }
    texture.dispose();
  });

  it('removes stale sky illumination when the borrowed LUT is cleared', () => {
    const texture = new DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, RGBAFormat, FloatType);
    const probe = new SkyLightProbe();
    const position = new Vector3(EARTH_RADIUS_M + 100, 0, 0);
    const sun = new Vector3(1, 0, 0);
    updateFlightSkyProbe(probe, texture, position, sun);
    expect(probe.sh.coefficients[0].length()).toBeGreaterThan(0);
    expect(updateFlightSkyProbe(probe, null, position, sun)).toBe(false);
    expect(probe.intensity).toBe(0);
    expect(probe.sh.coefficients.every((coefficient) => coefficient.lengthSq() === 0)).toBe(true);
    expect(probe.irradianceTexture).toBeNull();
    texture.dispose();
  });

  it('releases each old shadow target once so quality changes can reallocate it', () => {
    const shadow = new DirectionalLight().shadow;
    const target = new WebGLRenderTarget(4, 4);
    let disposed = 0;
    target.addEventListener('dispose', () => disposed++);
    shadow.map = shadow.mapPass = target;
    disposeFlightShadowMap(shadow);
    disposeFlightShadowMap(shadow);
    expect(disposed).toBe(1);
    expect(shadow.map).toBeNull();
    expect(shadow.mapPass).toBeNull();
  });
});

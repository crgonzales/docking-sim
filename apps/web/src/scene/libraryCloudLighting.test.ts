import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudsEffect } from '@takram/three-clouds';
import { Vector3 } from 'three';
import { configureCloudLighting } from './libraryCloudLighting';
import { directionToECEF } from './libraryFrame';

const disposables: CloudsEffect[] = [];
afterEach(() => disposables.splice(0).forEach(effect => effect.dispose()));
function effect(preset: 'low' | 'medium' | 'high' = 'medium') {
  const clouds = new CloudsEffect();
  disposables.push(clouds);
  clouds.qualityPreset = preset;
  return clouds;
}
const source = (packageName: string, file: string) => readFileSync(
  new URL(`../../node_modules/@takram/${packageName}/${file}`, import.meta.url), 'utf8');
function body(shader: string, name: string): string {
  const match = new RegExp(`\\b(?:void|vec[234])\\s+${name}\\([^)]*\\)\\s*\\{`).exec(shader);
  if (!match) throw new Error(`Missing shader function ${name}`);
  const start = match.index + match[0].length;
  let depth = 1, end = start;
  while (depth && end < shader.length) {
    const char = shader[end++];
    if (char === '{') depth++;
    if (char === '}') depth--;
  }
  return shader.slice(start, end - 1);
}
const anchors = [
  'in CloudsIrradiance vCloudsIrradiance;',
  '  skyIrradiance = vGroundIrradiance.sky;\n  return vGroundIrradiance.sun;',
  '  skyIrradiance = mix(vCloudsIrradiance.minSky, vCloudsIrradiance.maxSky, alpha);\n  return mix(vCloudsIrradiance.minSun, vCloudsIrradiance.maxSun, alpha);',
  '    vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;',
];

describe('pinned cloud ray illumination adapter', () => {
  it('pins shader packages and their scalar/surface irradiance and photometric contracts', () => {
    expect(JSON.parse(source('three-clouds', 'package.json')).version).toBe('0.7.6');
    expect(JSON.parse(source('three-atmosphere', 'package.json')).version).toBe('0.19.1');
    const runtime = source('three-atmosphere', 'src/shaders/bruneton/runtime.glsl');
    expect(runtime).toContain('max(dot(normal, sun_direction), 0.0)');
    expect(runtime).toContain('2.0 * PI;'); // Scalar sky integrates over solid angle.
    expect(runtime).toContain('#define GetSunAndSkyIrradiance GetSunAndSkyIlluminance');
    expect(runtime).toContain('#define GetSunAndSkyScalarIrradiance GetSunAndSkyScalarIlluminance');
    expect(runtime).toContain('sky_irradiance *= SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;');
  });

  it.each(['low', 'medium', 'high'] as const)('patches %s while preserving accurate lighting, vertex shader and shadow pass', preset => {
    const clouds = effect(preset), material = clouds.cloudsPass.currentMaterial;
    const fragment = material.fragmentShader, vertex = material.vertexShader;
    const shadow = clouds.shadowPass.currentMaterial.fragmentShader;
    const accurate = clouds.clouds.accurateSunSkyLight, version = material.version;
    configureCloudLighting(clouds);
    expect(clouds.clouds.accurateSunSkyLight).toBe(accurate);
    expect(accurate).toBe(preset === 'high');
    expect(material.vertexShader).toBe(vertex);
    expect(clouds.shadowPass.currentMaterial.fragmentShader).toBe(shadow);
    expect(material.version).toBe(version + 1);
    for (const name of ['getGroundSunSkyIrradiance', 'getCloudsSunSkyIrradiance']) {
      expect(body(material.fragmentShader, name).split('#else')[0]).toBe(body(fragment, name).split('#else')[0]);
    }
    expect(body(material.fragmentShader, 'marchClouds')).toBe(body(fragment, 'marchClouds'));
    expect(body(material.fragmentShader, 'approximateHaze')).toBe(body(fragment, 'approximateHaze'));
    const patched = material.fragmentShader;
    expect(() => configureCloudLighting(clouds)).toThrow('Pinned cloud lighting changed');
    expect(material.fragmentShader).toBe(patched);
    expect(material.version).toBe(version + 1);
  });

  it.each(anchors.flatMap((anchor, index) => ['missing', 'duplicate'].map(mode => ({ anchor, index, mode }))))(
    'rejects $mode anchor $index atomically', ({ anchor, mode }) => {
      const clouds = effect(), material = clouds.cloudsPass.currentMaterial;
      expect(material.fragmentShader.split(anchor)).toHaveLength(2);
      material.fragmentShader = mode === 'missing' ? material.fragmentShader.replace(anchor, '') : material.fragmentShader + anchor;
      const fragment = material.fragmentShader, version = material.version;
      expect(() => configureCloudLighting(clouds)).toThrow('Pinned cloud lighting changed');
      expect(material.fragmentShader).toBe(fragment);
      expect(material.version).toBe(version);
    });

  it('initializes all six cache members once before the sole march call, in the corrected ECEF frame', () => {
    const clouds = effect(), material = clouds.cloudsPass.currentMaterial;
    configureCloudLighting(clouds);
    const shader = material.fragmentShader, main = body(shader, 'main');
    expect(main).toContain('vec3 cameraPosition = vCameraPosition + altitudeCorrection;');
    expect(main).toContain('vec3 rayDirection = normalize(vRayDirection);');
    expect(main.indexOf('if (!intersectsGround && !intersectsScene)')).toBeLessThan(main.indexOf('sampleRayIrradiance(rayOrigin)'));
    expect(main).toContain('vec3 rayOrigin = rayNearFar.x * rayDirection + cameraPosition;\n    #ifndef ACCURATE_SUN_SKY_LIGHT\n    sampleRayIrradiance(rayOrigin);\n    #endif');
    expect(main.match(/sampleRayIrradiance\(/g)).toHaveLength(1);
    expect(main.match(/marchClouds\(/g)).toHaveLength(1);
    expect(main.indexOf('sampleRayIrradiance(rayOrigin)')).toBeLessThan(main.indexOf('marchClouds('));
    const cache = body(shader, 'sampleRayIrradiance');
    for (const member of ['rayGroundIrradiance.sun', 'rayGroundIrradiance.sky', 'rayCloudsIrradiance.minSun',
      'rayCloudsIrradiance.minSky', 'rayCloudsIrradiance.maxSun', 'rayCloudsIrradiance.maxSky']) expect(cache).toContain(member);
    expect(cache.match(/GetSunAndSky(?:Scalar)?Irradiance\(/g)).toHaveLength(3);
    expect(cache).toContain('normal * bottomRadius * METER_TO_LENGTH_UNIT, normal, sunDirection');
    expect(cache).toContain('normal * (bottomRadius + minHeight) * METER_TO_LENGTH_UNIT');
    expect(cache).toContain('normal * (bottomRadius + maxHeight) * METER_TO_LENGTH_UNIT');
    expect(Number(material.defines.METER_TO_LENGTH_UNIT)).toBe(0.001);
    expect(body(shader, 'getCloudsSunSkyIrradiance')).toContain('float alpha = remapClamped(height, minHeight, maxHeight);');
  });
});

// Analytical spherical geometry and opaque-planet solar-disc visibility, not
// a CPU approximation of the atmospheric LUT radiance or cloud density march.
const radius = 6360000, minHeight = 1000, maxHeight = 8000;
const sunAngularRadius = 0.004675;
const atHeight = (direction: Vector3, height: number) => direction.clone().normalize().multiplyScalar(radius + height);
function discVisibility(position: Vector3, sun: Vector3): number {
  const r = position.length(), mu = position.dot(sun) / r;
  const sineHorizon = radius / r, cosineHorizon = -Math.sqrt(1 - sineHorizon ** 2);
  const halfWidth = sineHorizon * sunAngularRadius;
  const t = Math.max(0, Math.min(1, (mu - cosineHorizon + halfWidth) / (2 * halfWidth)));
  return t * t * (3 - 2 * t);
}

describe('ray-column geometry and terminator approximation limits', () => {
  it('matches the installed atmosphere solar-disc occlusion law and length units', () => {
    const common = source('three-atmosphere', 'src/shaders/bruneton/common.glsl');
    expect(common).toContain('Number sin_theta_h = atmosphere.bottom_radius / r;');
    expect(common).toContain('mu_s - cos_theta_h');
    expect(common).toContain('sin_theta_h * atmosphere.sun_angular_radius / rad');
    const clouds = effect();
    const uniforms = clouds.cloudsPass.currentMaterial.uniforms;
    expect(uniforms.bottomRadius.value).toBe(radius);
    expect(uniforms.ATMOSPHERE.value.sun_angular_radius).toBeCloseTo(sunAngularRadius, 6);
    expect(atHeight(new Vector3(0, 1, 0), maxHeight).length() * 0.001).toBe(6368);
  });

  it('preserves normal-to-sun angles under the render-to-ECEF axis mapping', () => {
    const normal = new Vector3(0.4, 0.5, -0.6).normalize(), sun = new Vector3(0.9, -0.2, 0.3).normalize();
    expect(directionToECEF(normal).dot(directionToECEF(sun))).toBeCloseTo(normal.dot(sun), 14);
    expect(directionToECEF(sun).length()).toBeCloseTo(1, 14);
  });

  it('separates the visible whole-Earth day/night columns that a camera-local cache gives identical illumination', () => {
    const camera = new Vector3(0, radius + 4000000, 0), sun = new Vector3(1, 0, 0);
    const cameraColumn = camera.clone().normalize();
    expect(discVisibility(atHeight(cameraColumn, maxHeight), sun)).toBe(1);
    for (const angle of [-30, -20, -10, 10, 20, 30]) {
      const normal = new Vector3(Math.sin(angle * Math.PI / 180), Math.cos(angle * Math.PI / 180), 0);
      const entry = atHeight(normal, maxHeight);
      // Positive dot guarantees this is the near, visible cloud-sphere
      // intersection, rather than a hidden point on the back of the globe.
      expect(camera.clone().sub(entry).dot(normal)).toBeGreaterThan(0);
      expect(discVisibility(atHeight(entry, minHeight), sun)).toBe(angle > 0 ? 1 : 0);
      expect(discVisibility(atHeight(entry, maxHeight), sun)).toBe(angle > 0 ? 1 : 0);
    }
  });

  it('is exact in column direction for a nadir ray but remains camera-local inside the envelope', () => {
    const camera = new Vector3(0, radius + 400000, 0);
    const entry = camera.clone().addScaledVector(new Vector3(0, -1, 0), 400000 - maxHeight);
    expect(entry.clone().normalize().distanceTo(camera.clone().normalize())).toBeLessThan(1e-14);
    const shader = effect().cloudsPass.currentMaterial.fragmentShader;
    expect(shader).toContain('nearFar = vec2(cameraNear, intersections.first.y);');
    expect(shader).toContain('nearFar = vec2(cameraNear, intersections.second.z);');
    const inside = new Vector3(0, radius + 7000, 0);
    const insideEntry = inside.clone().add(new Vector3(0.5, 0, 0));
    expect(insideEntry.clone().normalize().distanceTo(inside.clone().normalize())).toBeLessThan(8e-8);
  });

  it('documents a 400km limb ray whose cached night column cannot light sunlit clouds farther along the ray', () => {
    const perigeeRadius = radius + 2000;
    const xAtHeight = (height: number) => Math.sqrt((radius + height) ** 2 - perigeeRadius ** 2);
    const camera = new Vector3(-xAtHeight(400000), perigeeRadius, 0);
    const entry = new Vector3(-xAtHeight(maxHeight), perigeeRadius, 0);
    const farCloud = new Vector3(xAtHeight(2500), perigeeRadius, 0);
    const sun = new Vector3(Math.cos(2 * Math.PI / 180), -Math.sin(2 * Math.PI / 180), 0);
    expect(entry.clone().normalize().angleTo(camera.clone().normalize())).toBeGreaterThan(0.29);
    expect(2 * xAtHeight(maxHeight)).toBeCloseTo(552738.636, 2);
    expect(discVisibility(atHeight(entry, minHeight), sun)).toBe(0);
    expect(discVisibility(atHeight(entry, maxHeight), sun)).toBe(0);
    expect(discVisibility(farCloud, sun)).toBe(1);
    // Both cached direct terms are zero: every interpolated height stays dark.
    // This is a geometric counterexample, not a claim this pixel is occupied
    // or that the finite GPU march reaches the far cloud.
  });

  it('documents inherited vertical interpolation leaking upper-layer sunlight into an occluded lower layer', () => {
    const normal = new Vector3(0, 1, 0);
    const sun = new Vector3(Math.cos(2 * Math.PI / 180), -Math.sin(2 * Math.PI / 180), 0);
    const low = discVisibility(atHeight(normal, minHeight), sun);
    const high = discVisibility(atHeight(normal, maxHeight), sun);
    expect(low).toBe(0);
    expect(high).toBe(1);
    expect(discVisibility(atHeight(normal, 2000), sun)).toBe(0);
    const alpha = (2000 - minHeight) / (maxHeight - minHeight);
    expect(low * (1 - alpha) + high * alpha).toBeCloseTo(1 / 7, 14);
  });
});

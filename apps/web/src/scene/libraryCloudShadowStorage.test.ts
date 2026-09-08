import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AerialPerspectiveEffect } from '@takram/three-atmosphere';
import { CloudsEffect } from '@takram/three-clouds';
import { DataUtils, HalfFloatType, LinearFilter, PerspectiveCamera, Vector3 } from 'three';
import { CLOUD_SHADOW_STORAGE as ABI, configureCloudShadowStorage, stableAerialShadowStorage } from './libraryCloudShadowStorage';
import { stableAerialDepth, stabilizeCloudDepth, stabilizeCloudHeight } from './libraryDepth';
import { configureCloudTemporal } from './libraryCloudTemporal';
import { useGlobalCloudWeather } from './libraryCloudWeather';

const owned: { dispose(): void }[] = [];
afterEach(() => owned.splice(0).forEach(value => value.dispose()));
function own<T extends { dispose(): void }>(value: T): T { owned.push(value); return value; }
const camera = () => new PerspectiveCamera(45, 1, 0.5, 1e8);
const effect = () => own(new CloudsEffect(camera()));
const aerial = () => own(new AerialPerspectiveEffect(camera()));
const materials = (clouds: CloudsEffect) => [clouds.shadowPass.currentMaterial, clouds.shadowPass.resolveMaterial, clouds.cloudsPass.currentMaterial];
const snapshot = (clouds: CloudsEffect) => materials(clouds).map(m => [m.fragmentShader, m.version]);
const READ = '  vec4 shadow = texture(shadowBuffer, vec3(uv, float(cascadeIndex)));';
const DECODE = '  shadow *= vec4(1e3, 1e-3, 1e3, 1e3);';
const error = 'Pinned Takram shadow storage shader changed';

// IEEE binary16 round-to-nearest-even, including overflow. Three's toHalfFloat
// clamps to 65504 and truncates, so using it as the storage oracle hides this bug.
function half(value: number): number {
  value = Math.fround(value);
  if (!Number.isFinite(value) || value === 0) return value;
  const sign = Math.sign(value), x = Math.abs(value);
  if (x >= 65520) return sign * Infinity;
  const step = 2 ** Math.max(-24, Math.floor(Math.log2(x)) - 10);
  const units = x / step, low = Math.floor(units), fraction = units - low;
  const rounded = fraction > 0.5 || (fraction === 0.5 && low % 2 !== 0) ? low + 1 : low;
  return sign * rounded * step;
}
type Texel = [number, number, number, number];
const scales: Texel = [ABI.distanceScale, ABI.extinctionScale, ABI.opticalDepthScale, ABI.opticalDepthScale];
const encode = (physical: Texel): Texel => physical.map((v, i) => v * scales[i]) as Texel;
const decode = (stored: Texel): Texel => stored.map((v, i) => v / scales[i]) as Texel;
const store = (physical: Texel): Texel => encode(physical).map(half) as Texel;
const mix = (a: Texel, b: Texel, t: number): Texel => a.map((v, i) => v * (1 - t) + b[i] * t) as Texel;
function opticalDepth(texel: Texel, distanceToTop: number, distanceOffset = 0, tail = false): number {
  const [front, extinction, maximum, opticalTail] = texel;
  return Math.min(maximum + (tail ? opticalTail : 0), extinction * Math.max(0, distanceToTop - distanceOffset - front));
}

describe('installed pinned shader ABI', () => {
  it('pins versions and every shadow texture read, including four debug cascades', () => {
    for (const [name, version] of [['three-clouds', '0.7.6'], ['three-atmosphere', '0.19.1']]) {
      const pkg = JSON.parse(readFileSync(new URL(`../../node_modules/@takram/${name}/package.json`, import.meta.url), 'utf8'));
      expect(pkg.version).toBe(version);
    }
    const clouds = effect();
    const before = materials(clouds).map(m => m.fragmentShader);
    const originalAerial = aerial().getFragmentShader();
    expect(before[2].match(/texture\(shadowBuffer,/g)).toHaveLength(5);
    expect(originalAerial.match(/texture\(shadowBuffer,/g)).toHaveLength(1);
    configureCloudShadowStorage(clouds);
    const after = materials(clouds).map(m => m.fragmentShader);
    const patchedAerial = stableAerialShadowStorage(originalAerial);
    expect(after[2].split(DECODE)).toHaveLength(3);
    expect(patchedAerial.split(DECODE)).toHaveLength(2);
    for (const source of [after[2], patchedAerial]) expect(source).toContain(`${READ}\n${DECODE}`);
    // The numerical oracle's scales must be the actual shader's write/read ABI.
    const encoded = after[0].match(/outputColor = color \* vec4\(([^)]+)\)/)![1].split(',').map(Number);
    const decoded = patchedAerial.match(/shadow \*= vec4\(([^)]+)\)/)![1].split(',').map(Number);
    expect(encoded).toEqual(scales);
    expect(decoded).toEqual(scales.map(scale => 1 / scale));
    expect(after[0]).toContain(`color.x * ${ABI.motionDepthScale.toExponential().replace('+', '')}`);
  });

  it.each([false, true])('keeps half-float linear targets and finite clear output with temporalPass=%s', temporal => {
    const clouds = effect();
    clouds.shadowPass.temporalPass = temporal;
    const output = clouds.shadowPass.outputBuffer;
    configureCloudShadowStorage(clouds);
    expect(clouds.shadowPass.outputBuffer).toBe(output);
    expect(output.type).toBe(HalfFloatType);
    expect(output.minFilter).toBe(LinearFilter);
    expect(output.magFilter).toBe(LinearFilter);
    const shader = clouds.shadowPass.currentMaterial.fragmentShader;
    expect(shader).toContain('return vec4(maxRayDistance, 0.0, 0.0, 0.0);');
    expect(shader).toContain('rayFar = 1e6;');
    expect(shader).toContain('outputColor = color * vec4(1e-3, 1e3, 1e-3, 1e-3);');
    expect(shader).toContain('outputDepthVelocity = vec3(0.0);');
    expect(store([1e6, 0, 0, 0])).toEqual([1000, 0, 0, 0]);
  });

  it('keeps physical front positions and UV velocity, scaling only motion-order depth', () => {
    const clouds = effect();
    const before = materials(clouds).map(m => m.fragmentShader);
    const versions = materials(clouds).map(m => m.version);
    configureCloudShadowStorage(clouds);
    const after = materials(clouds).map(m => m.fragmentShader);
    const motion = before[0].slice(before[0].indexOf('  vec3 frontPosition ='), before[0].indexOf('  outputDepthVelocity = vec3(color.x, velocity);'));
    expect(after[0]).toContain(motion);
    expect(after[0]).not.toMatch(/color\.[xyzwrgba]+\s*[*\/]=/);
    expect(after[0]).toContain('outputDepthVelocity = vec3(color.x * 1e-4, velocity);');
    expect(after[0]).toContain('float frontDepth = transmittanceSum > 0.0');
    expect(after[0]).toContain(': min(rayDistance, maxRayDistance);');
    // The sphere intersections/range and the complete camera raymarch are intact.
    const range = before[0].slice(before[0].indexOf('void getRayNearFar('), before[0].indexOf('void cascade('));
    expect(after[0]).toContain(range);
    expect(after[2].slice(after[2].indexOf('float marchOpticalDepth('))).toBe(before[2].slice(before[2].indexOf('float marchOpticalDepth(')));
    expect(after[1]).toBe(before[1].replace(' + 1e-7;', ' + vec3(1e-10, 1e-4, 1e-10);'));
    expect(materials(clouds).map(m => m.version)).toEqual(versions.map(v => v + 1));
  });

  it('retains both physical optical-depth formulas and their different tail policies', () => {
    const clouds = effect();
    configureCloudShadowStorage(clouds);
    expect(clouds.cloudsPass.currentMaterial.fragmentShader).toContain('float distanceToFront = max(0.0, distanceToTop - distanceOffset - shadow.r);');
    expect(clouds.cloudsPass.currentMaterial.fragmentShader).toContain('return min(shadow.b + shadow.a, shadow.g * distanceToFront);');
    const original = aerial().getFragmentShader();
    const patched = stableAerialShadowStorage(original);
    expect(patched.replace(`${READ}\n${DECODE} // Restore physical shadow units after filtering.`, READ)).toBe(original);
    expect(patched).toContain('return min(shadow.b, shadow.g * max(0.0, distanceToTop - shadow.r));');
  });

  it.each([false, true])('composes with existing weather/depth/temporal adapters, storage first=%s', first => {
    const clouds = effect();
    const otherAdapters = () => {
      useGlobalCloudWeather(clouds);
      stabilizeCloudDepth(clouds);
      stabilizeCloudHeight(clouds);
      configureCloudTemporal(clouds, true);
    };
    if (first) configureCloudShadowStorage(clouds);
    otherAdapters();
    if (!first) configureCloudShadowStorage(clouds);
    expect(clouds.cloudsPass.currentMaterial.fragmentShader).toContain(DECODE);
    const original = aerial().getFragmentShader();
    expect(stableAerialDepth(stableAerialShadowStorage(original))).toBe(stableAerialShadowStorage(stableAerialDepth(original)));
    class PairedAerial extends AerialPerspectiveEffect {
      constructor() { super(camera()); this.setFragmentShader(stableAerialShadowStorage(this.getFragmentShader())); }
    }
    expect(own(new PairedAerial()).getFragmentShader()).toBe(stableAerialShadowStorage(original));
  });

  const seams: [number, string][] = [
    [0, '  float frontDepth = min(weightedDistanceSum / transmittanceSum, maxRayDistance);'],
    [0, '  outputColor = color;'],
    [0, '  outputDepthVelocity = vec3(color.x, velocity);'],
    [0, '    return vec4(maxRayDistance, 0.0, 0.0, 0.0);'],
    [0, '  return vec4(frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail);'],
    [0, '  vec3 frontPosition = color.x * rayDirection + rayOrigin;'],
    [0, '  outputDepthVelocity = vec3(0.0);'],
    [0, '        maxOpticalDepth += media.extinction * stepSize;'],
    [0, '        stepSize * 0.5 // Excessive optical depth only introduces aliasing.'],
    [1, '  vec3 eClip = 0.5 * (maxColor.rgb - minColor.rgb) + 1e-7;'],
    [1, '  vec4 result = vec4(1e7, 0.0, 0.0, 0.0);'],
    [1, '  vec2 velocity = depthVelocity.gb * texelSize;'],
    [1, '  outputColor = mix(clippedHistory, current, temporalAlpha);'],
    [2, READ],
    [2, '  const float frontDepthScale = 1e-5;'],
    [2, '  float distanceToFront = max(0.0, distanceToTop - distanceOffset - shadow.r);'],
    [2, '  return min(shadow.b + shadow.a, shadow.g * distanceToFront);'],
    ...['xw, 0.0', 'zw, 1.0', 'xy, 2.0', 'zy, 3.0'].map(coord => [2, `      shadow = texture(shadowBuffer, vec3(coord.${coord}));`] as [number, string]),
  ];
  it.each(seams)('atomically rejects missing or duplicate material %i seam %s', (index, seam) => {
    for (const duplicate of [false, true]) {
      const clouds = effect(), material = materials(clouds)[index];
      expect(material.fragmentShader.split(seam)).toHaveLength(2);
      material.fragmentShader = duplicate ? material.fragmentShader + seam : material.fragmentShader.replace(seam, '');
      const before = snapshot(clouds);
      expect(() => configureCloudShadowStorage(clouds)).toThrow(error);
      expect(snapshot(clouds)).toEqual(before);
    }
  });

  it('rejects a repeated install and aerial seam drift without mutation', () => {
    const clouds = effect();
    configureCloudShadowStorage(clouds);
    const before = snapshot(clouds);
    expect(() => configureCloudShadowStorage(clouds)).toThrow(error);
    expect(snapshot(clouds)).toEqual(before);
    const original = aerial().getFragmentShader();
    for (const source of [
      stableAerialShadowStorage(original), original.replace(READ, ''), original + READ,
      original.replace('return min(shadow.b,', 'return min(shadow.a,'),
    ]) expect(() => stableAerialShadowStorage(source)).toThrow(error);
  });
});

describe('binary16 storage and Beer–Lambert oracles (CPU, not GPU execution)', () => {
  it('models overflow and ties correctly and round-trips every finite positive half', () => {
    for (let bits = 0; bits < 0x7c00; ++bits) {
      const value = DataUtils.fromHalfFloat(bits);
      expect(half(value)).toBe(value);
    }
    expect(half(65504)).toBe(65504);
    expect(half(65520)).toBe(Infinity);
    expect(half(70000)).toBe(Infinity);
    expect(half(1e6)).toBe(Infinity);
    expect(half(1 + 2 ** -11)).toBe(1);
    expect(half(1 + 3 * 2 ** -11)).toBe(1 + 2 ** -9);
    expect(half(2 ** -25)).toBe(0);
    expect(half(-1e6)).toBe(-Infinity);
  });

  const cases: [string, Texel, number, number][] = [
    ['valid below overflow', [12345, 0.0002, 2, 0.7], 17345, 300],
    ['valid beyond 65504 m', [70000, 0.002, 4, 1], 70400, 100],
    ['orbital front', [410234, 0.00015, 10, 4], 414000, 400],
    ['grazing front', [990123, 0.00002, 20, 10], 1000000, 900],
    ['clear sentinel', [1e6, 0, 0, 0], 2e6, 0],
    ['empty grazing interval', [-250000, 0, 0, 0], 1e6, 0],
    ['before front', [400000, 0.002, 10, 3], 399000, 0],
    ['B and A exceed half range', [400000, 0.002, 200000, 130000], 403000, 600],
    ['very thin extinction', [300000, 1e-8, 0.002, 0.001], 310000, 0],
  ];
  it.each(cases)('%s stays finite and matches analytic optical depth and transmittance', (_, physical, top, offset) => {
    const stored = store(physical), restored = decode(stored);
    expect(stored.every(Number.isFinite)).toBe(true);
    for (const tail of [false, true]) {
      const actual = opticalDepth(restored, top, tail ? offset : 0, tail);
      const expected = opticalDepth(physical, top, tail ? offset : 0, tail);
      // Product error bounded by independently quantized front and extinction;
      // min(cap, product) is 1-Lipschitz in each of those two arguments.
      const path = Math.max(0, top - (tail ? offset : 0) - physical[0]);
      const productError = Math.abs(restored[1] - physical[1]) * path + restored[1] * Math.abs(restored[0] - physical[0]);
      const capError = Math.abs(restored[2] - physical[2]) + (tail ? Math.abs(restored[3] - physical[3]) : 0);
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(productError, capError) + 1e-10);
      expect(Math.abs(Math.exp(-actual) - Math.exp(-expected))).toBeLessThan(0.005);
      if (physical[1] === 0) {
        expect(actual).toBe(0);
        expect(Math.exp(-actual)).toBe(1);
      }
    }
  });

  it('keeps zero extinction shadow-free and prevents the miss sentinel poisoning history variance', () => {
    const front = half(1e6);
    const legacyVariance = front * front - front * front;
    expect(Number.isNaN(legacyVariance)).toBe(true);
    expect(Number.isNaN(opticalDepth([legacyVariance, 0, 0, 0], 1e6))).toBe(true);
    for (const top of [0, 65504, 1e6, 1e8]) {
      expect(opticalDepth(decode(store([1e6, 0, 0, 0])), top)).toBe(0);
      expect(opticalDepth(decode(store([1e6, 0, 0, 0])), top, 500, true)).toBe(0);
    }
  });

  it('preserves bilinear and PCF identity across valid/grazing/clear texels', () => {
    const texels: Texel[] = [[70000, 0.00003, 4, 1], [410234, 0.00002, 3, 2], [990123, 0.00001, 2, 0.5], [1e6, 0, 0, 0]];
    const filtered = (values: Texel[], u: number, v: number) => mix(mix(values[0], values[1], u), mix(values[2], values[3], u), v);
    for (const tail of [false, true]) {
      const exactPCF: number[] = [], storedPCF: number[] = [];
      for (const [u, v] of [[0, 0], [0.17, 0.67], [0.5, 0.5], [0.96, 0.97], [1, 1]]) {
        const physical = filtered(texels, u, v);
        const exactDecoded = decode(filtered(texels.map(encode), u, v));
        physical.forEach((value, i) => expect(exactDecoded[i]).toBeCloseTo(value, 8));
        const quantized = decode(filtered(texels.map(store), u, v));
        const expected = opticalDepth(physical, 1005000, tail ? 900 : 0, tail);
        const actual = opticalDepth(quantized, 1005000, tail ? 900 : 0, tail);
        expect(Math.abs(Math.exp(-actual) - Math.exp(-expected))).toBeLessThan(0.001);
        exactPCF.push(expected); storedPCF.push(actual);
      }
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
      expect(Math.abs(Math.exp(-mean(exactPCF)) - Math.exp(-mean(storedPCF)))).toBeLessThan(0.001);
    }
  });

  it('keeps the nearest motion vector for clear and grazing rays without changing velocity', () => {
    const depths = [65504, 70000, 400000, 990123, 1e6, 12000000, 1e8];
    const stored = depths.map(d => half(d * ABI.motionDepthScale));
    expect(stored.every(Number.isFinite)).toBe(true);
    stored.forEach((value, i) => { if (i) expect(value).toBeGreaterThan(stored[i - 1]); });
    const velocities = [[1, 2], [-4, 8], [0.5, -1]];
    const neighbors = [1e6, 70000, 400000].map((d, i) => [half(d * ABI.motionDepthScale), ...velocities[i].map(half)]);
    expect(neighbors.reduce((a, b) => a[0] < b[0] ? a : b).slice(1)).toEqual([-4, 8]);
  });

  it('uses a finite physical sample position when first-step transmittance underflows', () => {
    const sampleDistance = 87500, extinction = 0.12, step = 1000;
    const weight = Math.fround(Math.exp(-extinction * step));
    expect(weight).toBe(0);
    const weightedDistance = Math.fround(sampleDistance * weight);
    expect(Number.isNaN(weightedDistance / weight)).toBe(true);
    const front = weight > 0 ? Math.min(weightedDistance / weight, 1e6) : Math.min(sampleDistance, 1e6);
    const direction = new Vector3(0.2, -0.9, 0.3).normalize(), origin = new Vector3(6300000, 100000, 0);
    const physicalPosition = direction.clone().multiplyScalar(front).add(origin);
    expect(physicalPosition.distanceTo(origin)).toBeCloseTo(sampleDistance, 8);
    expect(store([front, extinction, extinction * step, step * 0.5]).every(Number.isFinite)).toBe(true);
    expect(half(front * ABI.motionDepthScale)).toBeGreaterThan(0);
  });
});

describe('channel bounds and temporal filtering', () => {
  it('checks the installed structured step bound, including axes, face boundaries and grazing directions', () => {
    const shader = effect().shadowPass.currentMaterial.fragmentShader;
    // Pin the geometric assumptions behind the analytic icosahedron bound.
    for (const seam of [
      'const float a = 0.85065080835204;', 'const float b = 0.5257311121191336;',
      'const float kT = 0.6180339887498948;', 'const float kT2 = 0.38196601125010515;',
      'float selector1 = dot(absD, vec3(1.0, kT2, -kT));',
      'float selector2 = dot(absD, vec3(-kT, 1.0, kT2));',
      'float selector3 = dot(absD, vec3(kT2, -kT, 1.0));',
      'v1 = selector1 > 0.0 ? vec3(a, b, 0.0) : vec3(-b, 0.0, a);',
      'v2 = selector2 > 0.0 ? vec3(0.0, a, b) : vec3(a, -b, 0.0);',
      'v3 = selector3 > 0.0 ? vec3(b, 0.0, a) : vec3(0.0, a, -b);',
      'stepSize = samplePeriod / abs(NoD);',
      'clamp(maxRayDistance / float(maxIterationCount), minStepSize, maxStepSize),',
    ]) expect(shader).toContain(seam);
    const a = 0.85065080835204, b = 0.5257311121191336;
    const kT = 0.6180339887498948, kT2 = 0.38196601125010515;
    const directions = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(a, b, 0), new Vector3(0, a, b), new Vector3(b, 0, a)];
    for (let i = 0; i < 2048; ++i) {
      const z = 1 - 2 * (i + 0.5) / 2048, phi = i * Math.PI * (3 - Math.sqrt(5));
      directions.push(new Vector3(Math.sqrt(1 - z * z) * Math.cos(phi), Math.sqrt(1 - z * z) * Math.sin(phi), z));
    }
    let minimum = 1;
    for (const direction of directions) {
      const [x, y, z] = direction.toArray().map(Math.abs);
      const vertices = [
        x + kT2 * y - kT * z > 0 ? [a, b, 0] : [-b, 0, a],
        -kT * x + y + kT2 * z > 0 ? [0, a, b] : [a, -b, 0],
        kT2 * x - kT * y + z > 0 ? [b, 0, a] : [0, a, -b],
      ];
      for (const v of vertices) minimum = Math.min(minimum, v[0] * x + v[1] * y + v[2] * z);
    }
    expect(minimum).toBeGreaterThanOrEqual(1 / Math.sqrt(5) - 1e-14);
    expect(minimum).toBeCloseTo(1 / Math.sqrt(5), 12);
  });

  it.each(['low', 'medium', 'high', 'ultra'] as const)('proves all four channels fit the %s preset without assuming B/A are small', preset => {
    const clouds = effect();
    clouds.qualityPreset = preset;
    const shader = clouds.shadowPass.currentMaterial.fragmentShader;
    // Each of the four layer densities saturates independently, even if custom
    // profiles or weather would otherwise exceed one. No disjoint-layer premise.
    for (const expression of [
      'density = saturate(density * densityScales * getLayerDensity(weather.heightFraction));',
      'float densitySum = density.x + density.y + density.z + density.w;',
      'media.scattering = densitySum * scatteringCoefficient;',
      'media.extinction = densitySum * absorptionCoefficient + media.scattering;',
      'maxOpticalDepth += media.extinction * stepSize;',
      'stepSize * 0.5 // Excessive optical depth only introduces aliasing.',
    ]) expect(shader).toContain(expression);
    const u = clouds.shadowPass.currentMaterial.uniforms;
    const maxExtinction = 4 * (u.scatteringCoefficient.value + u.absorptionCoefficient.value);
    const maxStep = Math.sqrt(5) * clouds.shadow.maxStepSize;
    const topHeight = Math.max(...Array.from(clouds.cloudLayers, layer => layer.altitude + layer.height));
    const maxTerrestrialFront = Math.max(1e6, 2 * (u.bottomRadius.value + topHeight));
    const bounds: Texel = [maxTerrestrialFront, maxExtinction, clouds.shadow.maxIterationCount * maxExtinction * maxStep, maxStep / 2];
    encode(bounds).forEach(value => expect(value).toBeLessThan(ABI.halfFloatMax));
    expect(store(bounds).every(Number.isFinite)).toBe(true);
    // Early termination bounds B more tightly: it may overshoot -log(Tmin)
    // by ONE FULL STEP, not just reach the threshold and stop exactly there.
    const tighterB = -Math.log(clouds.shadow.minTransmittance) + maxExtinction * maxStep;
    expect(tighterB).toBeLessThan(bounds[2]);
    expect(tighterB).toBeGreaterThan(maxExtinction * maxStep);
  });

  it('handles a coarse structured step whose B and A both actually overflow unscaled half', () => {
    // Legal custom uniforms: the first sample is opaque, so its B and A are
    // exactly these values. The stock 1000 m maxStepSize is not a hard limit.
    const step = 60000 * Math.sqrt(5), extinction = 4, count = 1, tailScale = 2;
    const depth = extinction * step;
    const tail = Math.min(tailScale * step * Math.exp(1 - count), step / 2);
    expect(depth).toBeGreaterThan(ABI.halfFloatMax);
    expect(tail).toBeGreaterThan(ABI.halfFloatMax);
    expect([half(depth), half(tail)]).toEqual([Infinity, Infinity]);
    const physical: Texel = [250000, extinction, depth, tail];
    const restored = decode(store(physical));
    expect(restored.every(Number.isFinite)).toBe(true);
    // Check the cap itself, not just exp(-large) == 0, which could conceal loss.
    for (const withTail of [false, true]) {
      const expected = opticalDepth(physical, 1e6, 0, withTail);
      const actual = opticalDepth(restored, 1e6, 0, withTail);
      expect(Math.abs(actual / expected - 1)).toBeLessThan(0.001);
    }
  });

  // Installed varianceClipping + clipAABB, evaluated in double precision to
  // isolate change-of-units identity from half-storage quantization.
  function resolve(neighborhood: Texel[], history: Texel, epsilon: number[]): Texel {
    const mean = [0, 1, 2, 3].map(i => neighborhood.reduce((sum, v) => sum + v[i], 0) / neighborhood.length) as Texel;
    const variance = [0, 1, 2].map(i => Math.max(0, neighborhood.reduce((sum, v) => sum + v[i] ** 2, 0) / neighborhood.length - mean[i] ** 2));
    const unit = variance.map((v, i) => Math.abs((history[i] - mean[i]) / (Math.sqrt(v) + epsilon[i])));
    const largest = Math.max(...unit);
    const clipped = largest > 1 ? mix(mean, history, 1 / largest) : history;
    return mix(clipped, neighborhood[0], 0.01);
  }

  it('preserves history clipping under the linear ABI and remains finite over repeated half writes', () => {
    const clouds = effect();
    const stock = clouds.shadowPass.resolveMaterial.fragmentShader;
    for (const formula of [
      'vec4 moment2 = current * current;', 'moment2 += neighbor * neighbor;',
      'sqrt(max(moment2 / N - mean * mean, 0.0)) * gamma;',
      'vec4 vClip = history - vec4(pClip, current.a);',
      'vec3 vUnit = vClip.xyz / eClip;',
      'return vec4(pClip, current.a) + vClip / maUnit;',
    ]) expect(stock).toContain(formula);
    configureCloudShadowStorage(clouds);
    const patched = clouds.shadowPass.resolveMaterial.fragmentShader;
    const epsilon = patched.match(/vec3 eClip = .* \+ vec3\(([^)]+)\)/)![1].split(',').map(Number);
    expect(epsilon.map(Math.fround)).toEqual(scales.slice(0, 3).map(s => Math.fround(1e-7 * s)));
    const neighbors: Texel[] = Array.from({ length: 9 }, (_, i) => [400000 + i * 180, 0.0002 + i * 0.00001, 2 + i * 0.25, 0.1 + i * 0.125]);
    const physical: Texel = [1e6, 0.1, 90000, 70000];
    const exact = resolve(neighbors, physical, [1e-7, 1e-7, 1e-7]);
    const transformed = decode(resolve(neighbors.map(encode), encode(physical), epsilon));
    exact.forEach((v, i) => expect(transformed[i]).toBeCloseTo(v, 8));
    let stored = store(physical);
    const storedNeighbors = neighbors.map(store);
    for (let frame = 0; frame < 64; ++frame) {
      // Compare against the physical-unit resolver on the SAME quantized
      // history. Small 1% updates can stall below half an ULP; an unquantized
      // 64-frame history is not a valid tight-error reference for RGBA16F.
      const expectedPhysical = resolve(storedNeighbors.map(decode), decode(stored), [1e-7, 1e-7, 1e-7]);
      stored = resolve(storedNeighbors, stored, epsilon).map(half) as Texel;
      expect(stored.every(Number.isFinite)).toBe(true);
      const expected = Math.exp(-opticalDepth(expectedPhysical, 405000));
      const actual = Math.exp(-opticalDepth(decode(stored), 405000));
      const errors = encode(expectedPhysical).map((v, i) => (
        // Half an ULP in storage units, plus Float32 input conversion.
        0.5 * 2 ** Math.max(-24, Math.floor(Math.log2(Math.abs(v))) - 10) + Math.abs(v) * 2 ** -24
      ) / scales[i]);
      const path = Math.max(0, 405000 - expectedPhysical[0]);
      const productError = errors[1] * path + (expectedPhysical[1] + errors[1]) * errors[0];
      // min(cap, product) and exp(-tau) are 1-Lipschitz for nonnegative tau.
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(errors[2], productError) + 1e-9);
    }
    const clear = store([1e6, 0, 0, 0]);
    expect(resolve(Array.from({ length: 9 }, () => clear), clear, epsilon).map(half)).toEqual(clear);
  });
});

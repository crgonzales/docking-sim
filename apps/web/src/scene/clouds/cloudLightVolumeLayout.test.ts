import { describe, expect, it } from 'vitest';
import {
  CLOUD_LIGHT_QUALITY,
  canReuseCloudLightGeneration,
  cloudLightAltitudeSample,
  cloudLightPositionSample,
  cloudLightPositionToUv,
  cloudLightSliceAltitude,
  cloudLightSliceBatches,
  cloudLightSliceRange,
  cloudLightUvToPosition,
  completeCloudLightSliceBatch,
  createCloudLightFrame,
  createCloudLightGenerationState,
  createCloudLightVolumeLayout,
  invalidateCloudLightGenerations,
  planCloudLightAllocation,
  requestCloudLightGeneration,
  type CloudLightBuildInputs,
  type CloudLightGenerationState,
  type CloudLightLayoutOptions,
  type CloudLightQuality,
  type CloudLightUv,
  type CloudLightVec3,
} from './cloudLightVolumeLayout';

const R = 6_371_000;
const MIB = 1024 * 1024;
const BASE = 2_000;
const TOP = 12_000;
const defaults: CloudLightLayoutOptions = {
  quality: 'low', planetRadiusM: R, minAltitudeM: BASE, maxAltitudeM: TOP,
  cameraPositionECEFM: [0, 0, R + 400_000], cameraUpECEF: [0, 1, 0],
};
const layout = (overrides: Partial<CloudLightLayoutOptions> = {}) => createCloudLightVolumeLayout({ ...defaults, ...overrides });
const dot = (a: CloudLightVec3, b: CloudLightVec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: CloudLightVec3, s: number): CloudLightVec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: CloudLightVec3, b: CloudLightVec3): CloudLightVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function expectPosition(actual: CloudLightVec3 | null, expected: CloudLightVec3): void {
  expect(actual).not.toBeNull();
  expect(Math.hypot(actual![0] - expected[0], actual![1] - expected[1], actual![2] - expected[2])).toBeLessThan(1e-7);
}

describe('Earth-scale cloud lighting cap', () => {
  it.each<CloudLightVec3>([
    [R + 400_000, 0, 0], [0, R + 400_000, 0], [0, 0, R + 400_000],
    [0, 0, -R - 400_000], [1e-4, -1e-4, R + 400_000], [1e-4, -1e-4, -R - 400_000],
  ])('has an orthonormal radial frame at ECEF (%s, %s, %s)', (x, y, z) => {
    const position: CloudLightVec3 = [x, y, z];
    const frame = createCloudLightFrame(position, [0, 0, 1]);
    for (const axis of [frame.x, frame.y, frame.z]) expect(Math.hypot(...axis)).toBeCloseTo(1, 14);
    expect(dot(frame.x, frame.y)).toBeCloseTo(0, 14);
    expect(dot(frame.x, frame.z)).toBeCloseTo(0, 14);
    expect(dot(frame.y, frame.z)).toBeCloseTo(0, 14);
    expect(dot(frame.z, position)).toBeCloseTo(Math.hypot(...position), 7);
    const crossXY: CloudLightVec3 = [
      frame.x[1] * frame.y[2] - frame.x[2] * frame.y[1],
      frame.x[2] * frame.y[0] - frame.x[0] * frame.y[2],
      frame.x[0] * frame.y[1] - frame.x[1] * frame.y[0],
    ];
    expect(dot(crossXY, frame.z)).toBeCloseTo(1, 14);
  });

  it('follows camera up/roll and keeps the radial-up fallback stable across poles', () => {
    expect(createCloudLightFrame([0, 0, R], [0, 1, 0])).toEqual({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
    const rolled = createCloudLightFrame([0, 0, R], [1, 0, 0]);
    expect(rolled.x).toEqual([0, -1, 0]);
    expectPosition(rolled.y, [1, 0, 0]);
    for (const sign of [-1, 1]) {
      const pole = createCloudLightFrame([0, 0, sign * R], [0, 0, 1]);
      for (const offset of [-0.1, 0.1]) {
        const near = createCloudLightFrame([offset, -offset, sign * R], [0, 0, 1]);
        expect(dot(pole.x, near.x)).toBeGreaterThan(1 - 1e-12);
        expect(dot(pole.y, near.y)).toBeGreaterThan(1 - 1e-12);
      }
    }
  });

  it.each([0, 50, 1_000, 3_000, 20_000, 70_000, 120_000, 400_000])(
    'covers independently constructed Earth-tangent cloud horizons at camera altitude %s m',
    (cameraAltitude) => {
      const cap = layout({ cameraPositionECEFM: [0, 0, R + cameraAltitude] });
      // Tangency oracle built from the right triangle, without projection or
      // angular-extent formulas. C,T,P are collinear, |T|=R and CT is tangent.
      // P is the FAR positive cloud-sphere intersection.
      const rc = R + cameraAltitude;
      const cameraTangentDistance = Math.sqrt(cameraAltitude * (2 * R + cameraAltitude));
      const tangent: CloudLightVec3 = [R * cameraTangentDistance / rc, 0, R * R / rc];
      const tangentDirection: CloudLightVec3 = [R / rc, 0, -cameraTangentDistance / rc];
      expect(cap.coversHorizon).toBe(true);
      for (const altitude of [BASE, 7_000, TOP]) {
        const distance = Math.sqrt(altitude * (2 * R + altitude));
        const horizonPoint = add(tangent, scale(tangentDirection, distance));
        expect(Math.hypot(...horizonPoint)).toBeCloseTo(R + altitude, 7);
        const uv = cloudLightPositionToUv(cap, horizonPoint);
        expect(uv).not.toBeNull();
        expectPosition(cloudLightUvToPosition(cap, uv!, altitude), horizonPoint);
        expect(cloudLightPositionSample(cap, 'direct', horizonPoint).valid).toBe(true);
      }
    },
  );

  it.each<CloudLightVec3>([[0, 0, R + 50], [0, 0, -R - 400_000], [R + 400_000, 0, 0], [1, 1, R + 400_000]])(
    'round trips cap interior, altitude endpoints and rim at (%s, %s, %s)', (x, y, z) => {
      const cap = layout({ cameraPositionECEFM: [x, y, z], cameraUpECEF: [0, 0, 1] });
      const uvCases: CloudLightUv[] = [[0.5, 0.5], [0.2, 0.7], [0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1]];
      for (const uv of uvCases) for (const altitude of [BASE, 6_000, TOP]) {
        const position = cloudLightUvToPosition(cap, uv, altitude)!;
        expect(position).not.toBeNull();
        expect(Math.hypot(...position)).toBeCloseTo(R + altitude, 7);
        const sample = cloudLightPositionSample(cap, 'ambient', position);
        expect(sample.valid).toBe(true);
        expect(sample.uv![0]).toBeCloseTo(uv[0], 13);
        expect(sample.uv![1]).toBeCloseTo(uv[1], 13);
        expect(sample.altitudeM).toBeCloseTo(altitude, 7);
      }
    },
  );

  it('pins the stereographic half-angle mapping to an analytic direction', () => {
    const cap = layout();
    const angle = cap.supportedCapAngleRad * 0.7;
    const point: CloudLightVec3 = [(R + BASE) * Math.sin(angle), 0, (R + BASE) * Math.cos(angle)];
    const uv = cloudLightPositionToUv(cap, point)!;
    expect(uv[0]).toBeCloseTo(0.5 + Math.tan(angle / 2) / (2 * cap.capRadius), 14);
    expect(uv[1]).toBe(0.5);
    expectPosition(cloudLightUvToPosition(cap, uv, BASE), point);
  });

  it('reports bounded coverage honestly at very high orbit and with a smaller configured cap', () => {
    const high = layout({ cameraPositionECEFM: [0, 0, R * 100] });
    expect(high.horizonAngleRad).toBeGreaterThan(Math.PI / 2);
    expect(high.supportedCapAngleRad).toBe(Math.PI / 2);
    expect(high.coversHorizon).toBe(false);
    expect(high.coversRequestedCap).toBe(false);
    expect(cloudLightPositionToUv(high, [R + BASE, 0, 0])).not.toBeNull();
    expect(cloudLightPositionToUv(high, [R, 0, -100])).toBeNull();
    expect(cloudLightPositionToUv(high, [0, 0, -R - BASE])).toBeNull();
    const limited = layout({ maxCapAngleRad: 0.1 });
    expect(limited.supportedCapAngleRad).toBe(0.1);
    expect(limited.coversHorizon).toBe(false);
    const outside: CloudLightVec3 = [Math.sin(0.11), 0, Math.cos(0.11)];
    expect(cloudLightPositionToUv(limited, scale(outside, R + BASE))).toBeNull();
    const padded = layout({ maxCapAngleRad: layout().horizonAngleRad, horizonPaddingRad: 0.05 });
    expect(padded.coversHorizon).toBe(true);
    expect(padded.coversRequestedCap).toBe(false);
  });

  it('rejects square corners, points just beyond the disc and nonfinite inputs', () => {
    const cap = layout();
    const invalidUvs: CloudLightUv[] = [[0, 0], [1, 1], [1.00001, 0.5], [NaN, 0.5], [0.5, Infinity]];
    for (const uv of invalidUvs) expect(cloudLightUvToPosition(cap, uv, BASE)).toBeNull();
    for (const point of [[0, 0, 0], [NaN, 0, R], [0, Infinity, R]] as const) {
      expect(cloudLightPositionToUv(cap, point)).toBeNull();
      expect(cloudLightPositionSample(cap, 'direct', point).valid).toBe(false);
    }
    for (const altitude of [BASE - 1e-6, TOP + 1e-6, NaN, Infinity]) expect(cloudLightUvToPosition(cap, [0.5, 0.5], altitude)).toBeNull();
  });

  it('keeps geographic coordinates fixed through floating-origin rebases', () => {
    const cap = layout({ cameraPositionECEFM: [R + 400_000, 0, 0] });
    const pointECEF: CloudLightVec3 = [R + 5_000, 40_000, -25_000];
    const expected = cloudLightPositionSample(cap, 'direct', pointECEF);
    for (const origin of [[R, 0, 0], [R - 1_000_000, 200_000, -50_000], [0, 0, 0]] as const) {
      const local = add(pointECEF, scale(origin, -1));
      // The adapter restores ECEF before lookup; no local origin enters the layout.
      expect(cloudLightPositionSample(cap, 'direct', add(local, origin))).toEqual(expected);
    }
  });

  it('rejects invalid layout parameters and freezes every frame axis', () => {
    for (const bad of [
      { planetRadiusM: 0 }, { maxAltitudeM: BASE }, { minAltitudeM: -1 },
      { cameraPositionECEFM: [0, 0, R - 1] as const }, { cameraUpECEF: [0, 0, 0] as const },
      { maxCapAngleRad: Math.PI }, { maxCapAngleRad: 0 }, { horizonPaddingRad: -1 }, { maxAltitudeM: NaN },
    ]) expect(() => layout(bad)).toThrow(RangeError);
    const cap = layout();
    expect([cap, cap.frame, cap.frame.x, cap.frame.y, cap.frame.z].every(Object.isFrozen)).toBe(true);
  });
});

describe('strict direct/ambient altitude addressing', () => {
  it.each<CloudLightQuality>(['low', 'medium'])('never crosses quantity boundaries at %s quality', (quality) => {
    const cap = layout({ quality });
    const n = CLOUD_LIGHT_QUALITY[quality].slicesPerQuantity;
    for (const quantity of ['direct', 'ambient'] as const) {
      const first = quantity === 'direct' ? 0 : n;
      expect(cloudLightSliceRange(quality, quantity)).toEqual({ firstLayer: first, sliceCount: n });
      for (const h of [-Infinity, -1e20, BASE - 1e-6, BASE, 4_750, TOP, TOP + 1e-6, 1e20, Infinity, NaN]) {
        const sample = cloudLightAltitudeSample(cap, quantity, h);
        expect(sample.lowerLayer).toBeGreaterThanOrEqual(first);
        expect(sample.upperLayer).toBeLessThan(first + n);
        expect(sample.upperLayer).toBeGreaterThanOrEqual(sample.lowerLayer);
        expect(Number.isInteger(sample.lowerLayer) && Number.isInteger(sample.upperLayer)).toBe(true);
        expect(sample.mix).toBeGreaterThanOrEqual(0);
        expect(sample.mix).toBeLessThanOrEqual(1);
        expect(sample.valid).toBe(Number.isFinite(h) && h >= BASE && h <= TOP);
      }
      const top = cloudLightAltitudeSample(cap, quantity, TOP);
      expect(top).toEqual({ lowerLayer: first + n - 1, upperLayer: first + n - 1, mix: 0, valid: true });
      expect(() => cloudLightSliceAltitude(cap, quantity, first + n)).toThrow(RangeError);
      expect(() => cloudLightSliceAltitude(cap, quantity, first - 1)).toThrow(RangeError);
      expect(() => cloudLightSliceAltitude(cap, quantity, first + 0.5)).toThrow(RangeError);
      for (let i = 0; i < n; i++) {
        const h = cloudLightSliceAltitude(cap, quantity, first + i);
        const sample = cloudLightAltitudeSample(cap, quantity, h);
        const reconstructed = cloudLightSliceAltitude(cap, quantity, sample.lowerLayer) * (1 - sample.mix)
          + cloudLightSliceAltitude(cap, quantity, sample.upperLayer) * sample.mix;
        expect(reconstructed).toBeCloseTo(h, 9);
      }
    }
  });

  it('interpolates a midpoint and returns safe but INVALID below-cloud addresses', () => {
    const cap = layout();
    expect(cloudLightAltitudeSample(cap, 'direct', 7_000)).toEqual({ lowerLayer: 7, upperLayer: 8, mix: 0.5, valid: true });
    expect(cloudLightAltitudeSample(cap, 'ambient', 7_000)).toEqual({ lowerLayer: 23, upperLayer: 24, mix: 0.5, valid: true });
    const below = cloudLightPositionSample(cap, 'ambient', [0, 0, R + 50]);
    expect(below.uv).toEqual([0.5, 0.5]);
    expect(below.lowerLayer).toBe(16);
    expect(below.valid).toBe(false);
  });
});

describe('bounded light array allocations', () => {
  const limits = { maxTextureSize: 4096, maxArrayLayers: 256, reservedCloudBytes: 0 };
  it.each<CloudLightQuality>(['low', 'medium'])('accounts for both quantities and two complete %s buffers', (quality) => {
    const scalar = planCloudLightAllocation(quality, 'R16F', limits);
    const rgba = planCloudLightAllocation(quality, 'RGBA16F', limits);
    expect(scalar.width).toBe(quality === 'low' ? 96 : 128);
    expect(scalar.height).toBe(scalar.width);
    expect(scalar.layers).toBe(quality === 'low' ? 32 : 48);
    expect(scalar.bufferCount).toBe(2);
    expect(scalar.lightVolumeBytes).toBe((quality === 'low' ? 1.125 : 3) * MIB);
    expect(scalar.bytesPerBuffer * 2).toBe(scalar.lightVolumeBytes);
    expect(rgba.lightVolumeBytes).toBe(scalar.lightVolumeBytes * 4);
    const remaining = CLOUD_LIGHT_QUALITY[quality].maxCloudBytes - rgba.lightVolumeBytes;
    expect(planCloudLightAllocation(quality, 'RGBA16F', { ...limits, reservedCloudBytes: remaining }).totalCloudBytes).toBe(CLOUD_LIGHT_QUALITY[quality].maxCloudBytes);
    expect(() => planCloudLightAllocation(quality, 'RGBA16F', { ...limits, reservedCloudBytes: remaining + 1 })).toThrow(/memory cap/);
  });

  it('rejects device limits, fallback inflation and attempts to raise the system cap', () => {
    expect(() => planCloudLightAllocation('medium', 'R16F', { ...limits, maxArrayLayers: 47 })).toThrow(/device limits/);
    expect(() => planCloudLightAllocation('low', 'R16F', { ...limits, maxTextureSize: 95 })).toThrow(/device limits/);
    expect(() => planCloudLightAllocation('low', 'RGBA16F', { ...limits, maxCloudBytes: 2 * MIB })).toThrow(/memory cap/);
    expect(() => planCloudLightAllocation('low', 'R16F', { ...limits, reservedCloudBytes: 48 * MIB, maxCloudBytes: 100 * MIB })).toThrow(/memory cap/);
    for (const reservedCloudBytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => planCloudLightAllocation('low', 'R16F', { ...limits, reservedCloudBytes })).toThrow(RangeError);
    }
  });
});

const inputs = (generation: number, overrides: Partial<CloudLightBuildInputs> = {}): CloudLightBuildInputs => ({
  generation, weatherGeneration: 7, visualTimeSeconds: generation, sunDirectionECEF: [0, 0, 1], layout: layout(), ...overrides,
});

function finishBuild(state: CloudLightGenerationState): CloudLightGenerationState {
  const batches = cloudLightSliceBatches(state, { direct: 24, ambient: 24 });
  for (const batch of batches) state = completeCloudLightSliceBatch(state, batch);
  return state;
}

describe('bounded atomic generation publication', () => {
  it.each<CloudLightQuality>(['low', 'medium'])('publishes %s only after all direct AND ambient slices are acknowledged', (quality) => {
    let state = requestCloudLightGeneration(createCloudLightGenerationState(), inputs(1, { layout: layout({ quality }) }));
    const direct = cloudLightSliceBatches(state, { direct: 1000, ambient: 0 });
    expect(direct).toHaveLength(1);
    expect(direct[0].sliceCount).toBe(CLOUD_LIGHT_QUALITY[quality].slicesPerQuantity);
    expect(state.build!.directDone).toBe(0);
    expect(state.published).toBeNull();
    state = completeCloudLightSliceBatch(state, direct[0]);
    expect(state.published).toBeNull();
    const ambient = cloudLightSliceBatches(state, { direct: 1, ambient: 1000 })[0];
    state = completeCloudLightSliceBatch(state, { ...ambient, sliceCount: ambient.sliceCount - 1 });
    expect(state.published).toBeNull();
    const last = cloudLightSliceBatches(state, { direct: 1, ambient: 1 });
    expect(last).toHaveLength(1);
    state = completeCloudLightSliceBatch(state, last[0]);
    expect(state.build).toBeNull();
    expect(state.published!.inputs.generation).toBe(1);
    expect(state.published!.bufferIndex).toBe(0);
  });

  it('does not restart every frame, coalesces arrivals, freezes inputs and alternates buffers', () => {
    const sun: [number, number, number] = [0, 0, 1];
    const mutable = { ...inputs(1), sunDirectionECEF: sun };
    let state = requestCloudLightGeneration(createCloudLightGenerationState(), mutable);
    const firstId = state.build!.buildId;
    mutable.visualTimeSeconds = 999;
    sun[0] = 1;
    expect(state.build!.inputs.visualTimeSeconds).toBe(1);
    expect(state.build!.inputs.sunDirectionECEF).toEqual([0, 0, 1]);
    expect(Object.isFrozen(state.build!.inputs.sunDirectionECEF)).toBe(true);
    for (let frame = 2; frame <= 17; frame++) {
      state = requestCloudLightGeneration(state, inputs(frame));
      expect(state.build!.buildId).toBe(firstId);
      expect(state.build!.inputs.generation).toBe(1);
      expect(state.pending!.generation).toBe(frame);
      const batches = cloudLightSliceBatches(state, { direct: 2, ambient: 1 });
      for (const batch of batches) state = completeCloudLightSliceBatch(state, batch);
      if (frame < 17) expect(state.published).toBeNull();
    }
    expect(state.published!.inputs.generation).toBe(1);
    expect(state.build!.inputs.generation).toBe(17);
    expect(state.build!.bufferIndex).not.toBe(state.published!.bufferIndex);
    expect(state.pending).toBeNull();
    expect(requestCloudLightGeneration(state, inputs(17))).toBe(state);
    expect(requestCloudLightGeneration(state, inputs(5))).toBe(state);
    state = finishBuild(state);
    expect(state.published!.inputs.generation).toBe(17);
    expect(state.published!.bufferIndex).toBe(1);
    expect(requestCloudLightGeneration(state, inputs(18)).build!.bufferIndex).toBe(0);
  });

  it('budgets independently; proposals, failed work and duplicates do not advance cursors', () => {
    const initial = requestCloudLightGeneration(createCloudLightGenerationState(), inputs(1));
    expect(cloudLightSliceBatches(initial, { direct: 0, ambient: 0 })).toEqual([]);
    const batches = cloudLightSliceBatches(initial, { direct: 3, ambient: 2 });
    expect(batches.map(({ firstLayer, sliceCount }) => [firstLayer, sliceCount])).toEqual([[0, 3], [16, 2]]);
    expect(cloudLightSliceBatches(initial, { direct: 3, ambient: 2 })).toEqual(batches);
    expect(initial.build!.directDone).toBe(0);
    const advanced = completeCloudLightSliceBatch(initial, batches[0]);
    expect(completeCloudLightSliceBatch(advanced, batches[0])).toBe(advanced);
    expect(advanced.build!.directDone).toBe(3);
    expect(advanced.build!.ambientDone).toBe(0);
    expect(() => completeCloudLightSliceBatch(initial, { ...batches[0], sliceCount: 17 })).toThrow(RangeError);
    expect(() => cloudLightSliceBatches(initial, { direct: -1, ambient: 1 })).toThrow(RangeError);
    expect(() => cloudLightSliceBatches(initial, { direct: 1, ambient: 0.5 })).toThrow(RangeError);
    expect(() => cloudLightSliceBatches(initial, { direct: Infinity, ambient: 1 })).toThrow(RangeError);
  });

  it('cancels published, active and queued data on invalidation and rejects late completion', () => {
    let state = finishBuild(requestCloudLightGeneration(createCloudLightGenerationState(), inputs(1)));
    state = requestCloudLightGeneration(state, inputs(2));
    state = requestCloudLightGeneration(state, inputs(3));
    const stale = cloudLightSliceBatches(state, { direct: 16, ambient: 16 });
    const canceled = invalidateCloudLightGenerations(state);
    expect(canceled.published).toBeNull();
    expect(canceled.build).toBeNull();
    expect(canceled.pending).toBeNull();
    expect(completeCloudLightSliceBatch(canceled, stale[0])).toBe(canceled);
    // A fresh request may reuse a weather/input revision after context restore,
    // but its build token can never collide with a canceled GPU completion.
    state = requestCloudLightGeneration(canceled, inputs(2));
    expect(state.build!.buildId).toBeGreaterThan(stale[0].buildId);
    for (const batch of stale) expect(completeCloudLightSliceBatch(state, batch)).toBe(state);
    expect(state.published).toBeNull();
    expect(finishBuild(state).published!.inputs.generation).toBe(2);
  });

  it('requires invalidation before reallocating a different quality tier', () => {
    const state = requestCloudLightGeneration(createCloudLightGenerationState(), inputs(1));
    const medium = inputs(2, { layout: layout({ quality: 'medium' }) });
    expect(() => requestCloudLightGeneration(state, medium)).toThrow(/Invalidate/);
    const rebuilt = requestCloudLightGeneration(invalidateCloudLightGenerations(state), medium);
    expect(cloudLightSliceBatches(rebuilt, { direct: 24, ambient: 24 }).map((batch) => batch.sliceCount)).toEqual([24, 24]);
    expect(finishBuild(rebuilt).published!.inputs.layout.quality).toBe('medium');
  });

  it('requires bounded age/sun error, unchanged weather and valid old-frame coverage for reuse', () => {
    const published = finishBuild(requestCloudLightGeneration(createCloudLightGenerationState(), inputs(1))).published;
    const position: CloudLightVec3 = [0, 0, R + BASE];
    const tolerance = { maxAgeSeconds: 2, maxSunAngleRad: 0.01 };
    expect(canReuseCloudLightGeneration(null, inputs(1), position, tolerance)).toBe(false);
    expect(canReuseCloudLightGeneration(published, inputs(3), position, tolerance)).toBe(true);
    expect(canReuseCloudLightGeneration(published, inputs(4), position, tolerance)).toBe(false);
    expect(canReuseCloudLightGeneration(published, inputs(0), position, tolerance)).toBe(false);
    expect(canReuseCloudLightGeneration(published, inputs(1, { weatherGeneration: 8 }), position, tolerance)).toBe(false);
    expect(canReuseCloudLightGeneration(published, inputs(1, { sunDirectionECEF: [Math.sin(0.02), 0, Math.cos(0.02)] }), position, tolerance)).toBe(false);
    expect(canReuseCloudLightGeneration(published, inputs(1), [0, 0, R + 50], tolerance)).toBe(false);
    expect(canReuseCloudLightGeneration(published, inputs(1), [R + BASE, 0, 0], tolerance)).toBe(false);
    expect(canReuseCloudLightGeneration(published, inputs(1), position, { maxAgeSeconds: 0, maxSunAngleRad: 0 })).toBe(true);
  });
});

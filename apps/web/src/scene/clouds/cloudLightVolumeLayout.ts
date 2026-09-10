/** Pure CPU policy/oracles. ECEF metres and radians throughout; no render origin. */
export type CloudLightVec3 = readonly [number, number, number];
export type CloudLightUv = readonly [number, number];
export type CloudLightQuality = 'low' | 'medium';
export type CloudLightQuantity = 'direct' | 'ambient';
export type CloudLightFormat = 'R16F' | 'RGBA16F';

export interface CloudLightQualityConfig {
  readonly width: number;
  readonly height: number;
  readonly slicesPerQuantity: number;
  /** Whole cloud system, including resources outside this module. */
  readonly maxCloudBytes: number;
}

const MIB = 1024 * 1024;
const ROUND_OFF = 64 * Number.EPSILON;
export const CLOUD_LIGHT_QUALITY: Readonly<Record<CloudLightQuality, CloudLightQualityConfig>> = Object.freeze({
  low: Object.freeze({ width: 96, height: 96, slicesPerQuantity: 16, maxCloudBytes: 48 * MIB }),
  medium: Object.freeze({ width: 128, height: 128, slicesPerQuantity: 24, maxCloudBytes: 96 * MIB }),
});

function config(quality: CloudLightQuality): CloudLightQualityConfig {
  if (quality !== 'low' && quality !== 'medium') throw new RangeError('Unknown cloud light quality');
  return CLOUD_LIGHT_QUALITY[quality];
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
}

function dot(a: CloudLightVec3, b: CloudLightVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: CloudLightVec3, b: CloudLightVec3): CloudLightVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: CloudLightVec3): CloudLightVec3 {
  const length = Math.hypot(...v);
  if (!Number.isFinite(length) || length === 0) throw new RangeError('Expected a finite nonzero ECEF vector');
  return Object.freeze([v[0] / length, v[1] / length, v[2] / length] as const);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function horizonAngle(planetRadiusM: number, radiusM: number): number {
  const ratio = planetRadiusM / radiusM;
  // acos(R/r), avoiding loss of precision in 1-R/r close to the surface.
  return Math.atan2(Math.sqrt(((radiusM - planetRadiusM) / radiusM) * (1 + ratio)), ratio);
}

export interface CloudLightFrame {
  readonly x: CloudLightVec3;
  readonly y: CloudLightVec3;
  /** Camera geocentric radial direction, independent of camera look direction. */
  readonly z: CloudLightVec3;
}

/**
 * Right-handed frame: +Z is radial, +Y is projected camera up, +X = Y cross Z.
 * No longitude/north cross product, so geographic poles are ordinary positions.
 * When camera up is radial (projection < 1e-6), project a fixed X axis instead
 * (Y near +/-X). This is deterministic and stable around either geographic pole;
 * no stateless tangent frame can be globally continuous at every degeneracy.
 */
export function createCloudLightFrame(cameraPositionECEFM: CloudLightVec3, cameraUpECEF: CloudLightVec3): CloudLightFrame {
  const z = unit(cameraPositionECEFM);
  const up = unit(cameraUpECEF);
  const project = (v: CloudLightVec3): CloudLightVec3 => {
    const radial = dot(v, z);
    return [v[0] - radial * z[0], v[1] - radial * z[1], v[2] - radial * z[2]];
  };
  let tangent = project(up);
  if (Math.hypot(...tangent) < 1e-6) tangent = project(Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const x = unit(cross(unit(tangent), z));
  return Object.freeze({ x, y: unit(cross(z, x)), z });
}

export interface CloudLightLayoutOptions {
  readonly quality: CloudLightQuality;
  readonly planetRadiusM: number;
  readonly cameraPositionECEFM: CloudLightVec3;
  readonly cameraUpECEF: CloudLightVec3;
  /** Conservative support of ALL enabled cloud types, including displacement. */
  readonly minAltitudeM: number;
  readonly maxAltitudeM: number;
  /** Positive, at most pi/2. Back-facing radial directions are never supported. */
  readonly maxCapAngleRad?: number;
  readonly horizonPaddingRad?: number;
}

export interface CloudLightVolumeLayout {
  readonly quality: CloudLightQuality;
  readonly planetRadiusM: number;
  readonly minAltitudeM: number;
  readonly maxAltitudeM: number;
  readonly frame: CloudLightFrame;
  readonly horizonAngleRad: number;
  readonly requestedCapAngleRad: number;
  readonly supportedCapAngleRad: number;
  readonly coversHorizon: boolean;
  readonly coversRequestedCap: boolean;
  /** Dimensionless stereographic disc radius tan(supportedCapAngleRad / 2). */
  readonly capRadius: number;
}

/**
 * A ray tangent to the opaque planet reaches an elevated receiver at central
 * angle acos(R/rCamera) + acos(R/rReceiver). The cloud TOP maximizes this bound.
 * It includes the far intersection of the cloud shell visible past the surface
 * limb, including from below clouds; acos(rCloud/rCamera) would miss that region.
 * This is visibility coverage, not a promise that an oblique sun path stays in
 * the cap. Camera positions inside the planet are unsupported.
 */
export function createCloudLightVolumeLayout(options: CloudLightLayoutOptions): CloudLightVolumeLayout {
  config(options.quality);
  const { planetRadiusM, minAltitudeM, maxAltitudeM } = options;
  const limit = options.maxCapAngleRad ?? Math.PI / 2;
  const padding = options.horizonPaddingRad ?? 0;
  for (const value of [planetRadiusM, minAltitudeM, maxAltitudeM, limit, padding, planetRadiusM + maxAltitudeM]) finite(value, 'Layout bound');
  if (planetRadiusM <= 0 || minAltitudeM < 0 || maxAltitudeM <= minAltitudeM
    || limit <= 0 || limit > Math.PI / 2 || padding < 0) throw new RangeError('Invalid cloud cap bounds');
  const cameraRadius = Math.hypot(...options.cameraPositionECEFM);
  if (!Number.isFinite(cameraRadius) || cameraRadius < planetRadiusM) throw new RangeError('Camera must be on or above the planet');
  const horizonAngleRad = horizonAngle(planetRadiusM, cameraRadius) + horizonAngle(planetRadiusM, planetRadiusM + maxAltitudeM);
  const requestedCapAngleRad = Math.min(Math.PI, horizonAngleRad + padding);
  const supportedCapAngleRad = Math.min(limit, requestedCapAngleRad);
  const capRadius = Math.tan(supportedCapAngleRad / 2);
  if (capRadius === 0) throw new RangeError('Cloud cap is smaller than numeric precision');
  return Object.freeze({
    quality: options.quality, planetRadiusM, minAltitudeM, maxAltitudeM,
    frame: createCloudLightFrame(options.cameraPositionECEFM, options.cameraUpECEF),
    horizonAngleRad, requestedCapAngleRad, supportedCapAngleRad, capRadius,
    coversHorizon: supportedCapAngleRad >= horizonAngleRad,
    coversRequestedCap: supportedCapAngleRad >= requestedCapAngleRad,
  });
}

/**
 * GLSL oracle: d = transpose(mat3(frame.x, frame.y, frame.z)) * normalize(pECEF);
 * q = d.xy / (1 + d.z); uv = 0.5 + q / (2 * capRadius).
 * The ray originates at the PLANET CENTER, not the camera. Thus altitude spheres
 * have one positive intersection and geography cannot drift on a render rebase.
 * null means back-facing/outside disc/nonfinite. ROUND_OFF only absorbs CPU ulps.
 */
export function cloudLightPositionToUv(layout: CloudLightVolumeLayout, positionECEFM: CloudLightVec3): CloudLightUv | null {
  const radius = Math.hypot(...positionECEFM);
  if (!Number.isFinite(radius) || radius === 0) return null;
  const d: CloudLightVec3 = [positionECEFM[0] / radius, positionECEFM[1] / radius, positionECEFM[2] / radius];
  const z = dot(d, layout.frame.z);
  if (z < -ROUND_OFF) return null;
  const qx = dot(d, layout.frame.x) / (1 + z);
  const qy = dot(d, layout.frame.y) / (1 + z);
  if (Math.hypot(qx, qy) > layout.capRadius * (1 + ROUND_OFF)) return null;
  return [0.5 + qx / (2 * layout.capRadius), 0.5 + qy / (2 * layout.capRadius)];
}

/**
 * Inverse stereographic oracle: q = (2*uv-1)*capRadius;
 * d = vec3(2*q, 1-dot(q,q)) / (1+dot(q,q)); p = (R+h)*mat3(x,y,z)*d.
 * UV is a disc inside [0,1]^2, NOT the whole square. Square corners are invalid.
 * Altitude samples include both support endpoints. Builders evaluate texel-center
 * UVs; shader filtering must also honor the validity of contributing texels at
 * the disc rim. Geometric validity alone does not authorize an unmasked filter.
 */
export function cloudLightUvToPosition(layout: CloudLightVolumeLayout, uv: CloudLightUv, altitudeM: number): CloudLightVec3 | null {
  if (!uv.every(Number.isFinite) || !Number.isFinite(altitudeM)
    || altitudeM < layout.minAltitudeM || altitudeM > layout.maxAltitudeM) return null;
  const qx = (2 * uv[0] - 1) * layout.capRadius;
  const qy = (2 * uv[1] - 1) * layout.capRadius;
  const q2 = qx * qx + qy * qy;
  if (Math.hypot(qx, qy) > layout.capRadius * (1 + ROUND_OFF) || q2 > 1 + ROUND_OFF) return null;
  const d = [2 * qx / (1 + q2), 2 * qy / (1 + q2), (1 - q2) / (1 + q2)];
  const radius = layout.planetRadiusM + altitudeM;
  const component = (i: number) => radius * (layout.frame.x[i] * d[0] + layout.frame.y[i] * d[1] + layout.frame.z[i] * d[2]);
  return [component(0), component(1), component(2)];
}

export function cloudLightSliceRange(quality: CloudLightQuality, quantity: CloudLightQuantity): { readonly firstLayer: number; readonly sliceCount: number } {
  if (quantity !== 'direct' && quantity !== 'ambient') throw new RangeError('Unknown lighting quantity');
  const sliceCount = config(quality).slicesPerQuantity;
  return { firstLayer: quantity === 'direct' ? 0 : sliceCount, sliceCount };
}

export interface CloudLightAltitudeSample {
  readonly lowerLayer: number;
  readonly upperLayer: number;
  readonly mix: number;
  /** Clamped indices are safe addresses, not permission to sample outside support. */
  readonly valid: boolean;
}

/** Explicit interpolation of array layers; never use hardware filtering in Z. */
export function cloudLightAltitudeSample(layout: CloudLightVolumeLayout, quantity: CloudLightQuantity, altitudeM: number): CloudLightAltitudeSample {
  const { firstLayer, sliceCount } = cloudLightSliceRange(layout.quality, quantity);
  const valid = Number.isFinite(altitudeM) && altitudeM >= layout.minAltitudeM && altitudeM <= layout.maxAltitudeM;
  const t = Number.isNaN(altitudeM) ? 0 : clamp((altitudeM - layout.minAltitudeM) / (layout.maxAltitudeM - layout.minAltitudeM), 0, 1);
  const index = t * (sliceCount - 1);
  const lower = Math.floor(index);
  return { lowerLayer: firstLayer + lower, upperLayer: firstLayer + Math.min(lower + 1, sliceCount - 1), mix: index - lower, valid };
}

export function cloudLightSliceAltitude(layout: CloudLightVolumeLayout, quantity: CloudLightQuantity, layer: number): number {
  const { firstLayer, sliceCount } = cloudLightSliceRange(layout.quality, quantity);
  integer(layer, 'Array layer');
  if (layer < firstLayer || layer >= firstLayer + sliceCount) throw new RangeError('Layer belongs to another quantity or is out of range');
  return layout.minAltitudeM + (layout.maxAltitudeM - layout.minAltitudeM) * ((layer - firstLayer) / (sliceCount - 1));
}

/** Outside altitude support stays invalid, notably for below-cloud receivers. */
export function cloudLightPositionSample(layout: CloudLightVolumeLayout, quantity: CloudLightQuantity, positionECEFM: CloudLightVec3): CloudLightAltitudeSample & { readonly uv: CloudLightUv | null; readonly altitudeM: number } {
  const radius = Math.hypot(...positionECEFM);
  let altitudeM = radius - layout.planetRadiusM;
  // Sphere construction/norm round-off at Earth scale, not a physical guard band.
  const epsilonM = ROUND_OFF * (layout.planetRadiusM + layout.maxAltitudeM);
  if (Math.abs(altitudeM - layout.minAltitudeM) <= epsilonM) altitudeM = layout.minAltitudeM;
  if (Math.abs(altitudeM - layout.maxAltitudeM) <= epsilonM) altitudeM = layout.maxAltitudeM;
  const sample = cloudLightAltitudeSample(layout, quantity, altitudeM);
  const uv = cloudLightPositionToUv(layout, positionECEFM);
  return { ...sample, uv, altitudeM, valid: sample.valid && uv !== null };
}

export interface CloudLightAllocationLimits {
  readonly maxTextureSize: number;
  readonly maxArrayLayers: number;
  /** All other cloud allocations, including validity, scratch, view/history/assets. */
  readonly reservedCloudBytes: number;
  /** Optional stricter cap; never raises the quality tier's total system cap. */
  readonly maxCloudBytes?: number;
}

/** Caller first probes format renderability; this only validates CPU allocation policy. */
export function planCloudLightAllocation(quality: CloudLightQuality, format: CloudLightFormat, limits: CloudLightAllocationLimits) {
  const preset = config(quality);
  if (format !== 'R16F' && format !== 'RGBA16F') throw new RangeError('Unsupported light volume format');
  const cap = Math.min(preset.maxCloudBytes, limits.maxCloudBytes ?? preset.maxCloudBytes);
  for (const value of [limits.maxTextureSize, limits.maxArrayLayers, limits.reservedCloudBytes, limits.maxCloudBytes ?? cap]) integer(value, 'Allocation limit');
  const layers = 2 * preset.slicesPerQuantity;
  const bytesPerTexel = format === 'R16F' ? 2 : 8;
  const bytesPerBuffer = preset.width * preset.height * layers * bytesPerTexel;
  const lightVolumeBytes = 2 * bytesPerBuffer;
  const totalCloudBytes = lightVolumeBytes + limits.reservedCloudBytes;
  if (limits.maxTextureSize < Math.max(preset.width, preset.height) || limits.maxArrayLayers < layers) throw new RangeError('Cloud light array exceeds device limits');
  if (!Number.isSafeInteger(totalCloudBytes) || totalCloudBytes > cap) throw new RangeError('Cloud allocation exceeds total memory cap');
  return Object.freeze({ width: preset.width, height: preset.height, layers, format, bufferCount: 2 as const, bytesPerTexel, bytesPerBuffer, lightVolumeBytes, totalCloudBytes });
}

/**
 * generation must increase whenever any build input changes. weatherGeneration
 * identifies retained immutable weather/noise/type resources owned by the caller;
 * mutating those GPU resources in place during a build violates this contract.
 */
export interface CloudLightBuildInputs {
  readonly generation: number;
  readonly weatherGeneration: number;
  readonly visualTimeSeconds: number;
  readonly sunDirectionECEF: CloudLightVec3;
  readonly layout: CloudLightVolumeLayout;
}

export interface CloudLightPublishedGeneration {
  readonly buildId: number;
  readonly bufferIndex: 0 | 1;
  readonly inputs: CloudLightBuildInputs;
}

export interface CloudLightBuild extends CloudLightPublishedGeneration {
  readonly directDone: number;
  readonly ambientDone: number;
}

export interface CloudLightGenerationState {
  readonly nextBuildId: number;
  readonly published: CloudLightPublishedGeneration | null;
  readonly build: CloudLightBuild | null;
  readonly pending: CloudLightBuildInputs | null;
}

function freezeInputs(inputs: CloudLightBuildInputs): CloudLightBuildInputs {
  integer(inputs.generation, 'Generation');
  integer(inputs.weatherGeneration, 'Weather generation');
  finite(inputs.visualTimeSeconds, 'Visual time');
  // Layout factory output is deeply frozen; require it instead of trusting a
  // mutable structural lookalike whose coordinates could change under a build.
  if (!Object.isFrozen(inputs.layout) || !Object.isFrozen(inputs.layout.frame)
    || ![inputs.layout.frame.x, inputs.layout.frame.y, inputs.layout.frame.z].every(Object.isFrozen)) throw new TypeError('Use createCloudLightVolumeLayout for build layouts');
  return Object.freeze({ generation: inputs.generation, weatherGeneration: inputs.weatherGeneration,
    visualTimeSeconds: inputs.visualTimeSeconds, sunDirectionECEF: unit(inputs.sunDirectionECEF), layout: inputs.layout });
}

export function createCloudLightGenerationState(): CloudLightGenerationState {
  return Object.freeze({ nextBuildId: 1, published: null, build: null, pending: null });
}

function beginBuild(state: CloudLightGenerationState, inputs: CloudLightBuildInputs): CloudLightGenerationState {
  integer(state.nextBuildId + 1, 'Build ID');
  const build: CloudLightBuild = Object.freeze({ buildId: state.nextBuildId, bufferIndex: state.published?.bufferIndex === 0 ? 1 : 0, inputs, directDone: 0, ambientDone: 0 });
  return Object.freeze({ ...state, nextBuildId: state.nextBuildId + 1, build, pending: null });
}

/**
 * Latest-wins one-slot queue. Repeated/stale revisions never restart a build.
 * Invalidate before changing quality/allocations or making a camera cut; the
 * two existing buffers can only service a single allocation shape at a time.
 */
export function requestCloudLightGeneration(state: CloudLightGenerationState, inputs: CloudLightBuildInputs): CloudLightGenerationState {
  integer(inputs.generation, 'Generation');
  const latest = state.pending?.generation ?? state.build?.inputs.generation ?? state.published?.inputs.generation ?? -1;
  if (inputs.generation <= latest) return state;
  const frozen = freezeInputs(inputs);
  const resident = state.build?.inputs ?? state.published?.inputs;
  if (resident !== undefined && resident.layout.quality !== frozen.layout.quality) {
    throw new RangeError('Invalidate cloud light generations before changing allocation quality');
  }
  return state.build === null ? beginBuild(state, frozen) : Object.freeze({ ...state, pending: frozen });
}

export interface CloudLightSliceBatch {
  readonly buildId: number;
  readonly bufferIndex: 0 | 1;
  readonly quantity: CloudLightQuantity;
  readonly firstLayer: number;
  readonly sliceCount: number;
}

/** Read-only work proposal. A budget is slices per call, independently per quantity. */
export function cloudLightSliceBatches(state: CloudLightGenerationState, budget: Readonly<Record<CloudLightQuantity, number>>): readonly CloudLightSliceBatch[] {
  integer(budget.direct, 'Direct slice budget');
  integer(budget.ambient, 'Ambient slice budget');
  const build = state.build;
  if (build === null) return [];
  const batches: CloudLightSliceBatch[] = [];
  for (const quantity of ['direct', 'ambient'] as const) {
    const range = cloudLightSliceRange(build.inputs.layout.quality, quantity);
    const done = quantity === 'direct' ? build.directDone : build.ambientDone;
    const sliceCount = Math.min(budget[quantity], range.sliceCount - done);
    if (sliceCount > 0) batches.push(Object.freeze({ buildId: build.buildId, bufferIndex: build.bufferIndex, quantity, firstLayer: range.firstLayer + done, sliceCount }));
  }
  return Object.freeze(batches);
}

/**
 * Acknowledge a proposed batch ONLY after successful rendering of every slice.
 * Failure leaves the cursor unchanged for retry. Scheduling alone publishes
 * nothing. Every slice must initialize invalid cells/validity as well as valid
 * samples. Duplicate/stale completions cannot complete a different generation.
 * Read only published.bufferIndex and attach only build.bufferIndex; GPU owners
 * must additionally prohibit all feedback reads of their attached array.
 */
export function completeCloudLightSliceBatch(state: CloudLightGenerationState, batch: CloudLightSliceBatch): CloudLightGenerationState {
  const build = state.build;
  if (build === null || batch.buildId !== build.buildId || batch.bufferIndex !== build.bufferIndex) return state;
  const range = cloudLightSliceRange(build.inputs.layout.quality, batch.quantity);
  const done = batch.quantity === 'direct' ? build.directDone : build.ambientDone;
  if (batch.firstLayer !== range.firstLayer + done) return state;
  integer(batch.sliceCount, 'Completed slice count');
  if (batch.sliceCount === 0 || batch.sliceCount > range.sliceCount - done) throw new RangeError('Completion exceeds required slices');
  const next = Object.freeze({ ...build, [batch.quantity === 'direct' ? 'directDone' : 'ambientDone']: done + batch.sliceCount });
  if (next.directDone !== range.sliceCount || next.ambientDone !== range.sliceCount) return Object.freeze({ ...state, build: next });
  const published = Object.freeze({ buildId: next.buildId, bufferIndex: next.bufferIndex, inputs: next.inputs });
  const complete = Object.freeze({ ...state, published, build: null, pending: null });
  return state.pending === null ? complete : beginBuild(complete, state.pending);
}

/** Cuts, incompatible resource changes, context loss/disposal: cancel EVERYTHING.
 * IDs never rewind, so late GPU acknowledgements cannot resurrect canceled work.
 * Owner releases GPU targets on loss/disposal; this pure helper owns no resources.
 */
export function invalidateCloudLightGenerations(state: CloudLightGenerationState): CloudLightGenerationState {
  return Object.freeze({ nextBuildId: state.nextBuildId, published: null, build: null, pending: null });
}

/**
 * A completed buffer is not automatically current. Reuse requires unchanged
 * weather assets, bounded forward time/sun error, and coverage in its OWN frame.
 * A rebase does not affect ECEF; a below-layer receiver must integrate its sun
 * path to the cache support, not silently sample a clamped bottom layer.
 */
export function canReuseCloudLightGeneration(
  published: CloudLightPublishedGeneration | null,
  current: Pick<CloudLightBuildInputs, 'weatherGeneration' | 'visualTimeSeconds' | 'sunDirectionECEF'>,
  positionECEFM: CloudLightVec3,
  tolerance: { readonly maxAgeSeconds: number; readonly maxSunAngleRad: number },
): boolean {
  finite(tolerance.maxAgeSeconds, 'Maximum cache age');
  finite(tolerance.maxSunAngleRad, 'Maximum sun angle');
  if (tolerance.maxAgeSeconds < 0 || tolerance.maxSunAngleRad < 0 || tolerance.maxSunAngleRad > Math.PI) throw new RangeError('Invalid cache reuse tolerance');
  if (published === null) return false;
  const age = current.visualTimeSeconds - published.inputs.visualTimeSeconds;
  if (!Number.isFinite(age) || age < 0 || age > tolerance.maxAgeSeconds || current.weatherGeneration !== published.inputs.weatherGeneration) return false;
  const sun = unit(current.sunDirectionECEF);
  if (dot(sun, published.inputs.sunDirectionECEF) < Math.cos(tolerance.maxSunAngleRad) - ROUND_OFF) return false;
  return cloudLightPositionSample(published.inputs.layout, 'direct', positionECEFM).valid;
}

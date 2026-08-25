import {
  SKY_DERIVED,
  TERRAIN_SKIRT_DEPTH_M,
  TERRAIN_SPLIT_SCREEN_SPACE_ERROR_PX,
} from '../sky/skyConfig';

export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5;
export type TerrainEdge = 'north' | 'east' | 'south' | 'west';
export type Vec3 = readonly [number, number, number];

export interface TerrainNodeAddress {
  readonly face: CubeFace;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

export interface TerrainNodeBounds {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

export interface TerrainSkirtMetadata {
  readonly edge: TerrainEdge;
  readonly neighbor: TerrainNodeAddress;
  readonly depthM: number;
}

export interface TerrainLodOptions {
  /** Planet-centred camera position, in metres. */
  readonly planetRadiusM?: number;
  /** Projection scale in pixels per radian at the current viewport. */
  readonly projectionScalePx?: number;
  readonly splitThresholdPx?: number;
  readonly mergeThresholdPx?: number;
  readonly maxLevel?: number;
}

export type TerrainLodAction = 'split' | 'merge' | 'keep';

export interface TerrainLodDecision {
  readonly action: TerrainLodAction;
  readonly screenSpaceErrorPx: number;
}

const FACE_COUNT = 6;
const EDGE_ORDER: readonly TerrainEdge[] = ['north', 'east', 'south', 'west'];
const FACE_EPSILON = 1e-6;
const NEWTON_EPSILON = 1e-5;
const NEWTON_ITERATIONS = 12;

function assertFiniteVector(vector: Vec3): void {
  if (!vector.every(Number.isFinite)) throw new Error('Direction and camera positions must be finite');
}

function normalize(vector: Vec3): Vec3 {
  assertFiniteVector(vector);
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length === 0) throw new Error('A zero-length direction has no cube face');
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function angularDistance(a: Vec3, b: Vec3): number {
  return Math.acos(clamp(dot(a, b), -1, 1));
}

function nodeCount(level: number): number {
  if (!Number.isSafeInteger(level) || level < 0 || level > 30) {
    throw new Error(`Terrain node level must be an integer from 0 to 30, received ${level}`);
  }
  return 2 ** level;
}

export function validateNodeAddress(address: TerrainNodeAddress): void {
  if (!Number.isInteger(address.face) || address.face < 0 || address.face >= FACE_COUNT) {
    throw new Error(`Terrain node face must be an integer from 0 to 5, received ${address.face}`);
  }
  const count = nodeCount(address.level);
  if (!Number.isSafeInteger(address.x) || address.x < 0 || address.x >= count) {
    throw new Error(`Terrain node x must be in [0, ${count}), received ${address.x}`);
  }
  if (!Number.isSafeInteger(address.y) || address.y < 0 || address.y >= count) {
    throw new Error(`Terrain node y must be in [0, ${count}), received ${address.y}`);
  }
}

export function nodeAddressKey(address: TerrainNodeAddress): string {
  validateNodeAddress(address);
  return `${address.face}/${address.level}/${address.x}/${address.y}`;
}

export function parentAddress(address: TerrainNodeAddress): TerrainNodeAddress | null {
  validateNodeAddress(address);
  if (address.level === 0) return null;
  return {
    face: address.face,
    level: address.level - 1,
    x: Math.floor(address.x / 2),
    y: Math.floor(address.y / 2),
  };
}

export function childAddress(
  address: TerrainNodeAddress,
  childX: 0 | 1,
  childY: 0 | 1,
): TerrainNodeAddress {
  validateNodeAddress(address);
  return {
    face: address.face,
    level: address.level + 1,
    x: address.x * 2 + childX,
    y: address.y * 2 + childY,
  };
}

export function nodeUvBounds(address: TerrainNodeAddress): TerrainNodeBounds {
  validateNodeAddress(address);
  const size = 1 / nodeCount(address.level);
  return {
    uMin: address.x * size,
    uMax: (address.x + 1) * size,
    vMin: address.y * size,
    vMax: (address.y + 1) * size,
  };
}

export function nodeCenterFaceUv(address: TerrainNodeAddress): readonly [number, number] {
  const bounds = nodeUvBounds(address);
  return [(bounds.uMin + bounds.uMax) / 2, (bounds.vMin + bounds.vMax) / 2];
}

function cubeFaceCoordinates(face: CubeFace, s: number, t: number): Vec3 {
  switch (face) {
    // The local u axis is s and local v axis is t. These orientations put
    // +X at equirectangular u=.5, +Z at u=.25, and +Y at v=1, matching
    // cloudSphericalUv and SphereGeometry's existing registration.
    case 0: return [1, t, -s];
    case 1: return [-1, t, s];
    case 2: return [s, 1, -t];
    case 3: return [s, -1, t];
    case 4: return [s, t, 1];
    case 5: return [-s, t, -1];
  }
}

function spherifyCubeCoordinates(cube: Vec3): Vec3 {
  const [x, y, z] = cube;
  const xScale = Math.sqrt(Math.max(0, 1 - (y * y) / 2 - (z * z) / 2 + (y * y * z * z) / 3));
  const yScale = Math.sqrt(Math.max(0, 1 - (z * z) / 2 - (x * x) / 2 + (z * z * x * x) / 3));
  const zScale = Math.sqrt(Math.max(0, 1 - (x * x) / 2 - (y * y) / 2 + (x * x * y * y) / 3));
  return normalize([x * xScale, y * yScale, z * zScale]);
}

export function faceUvToDirection(face: CubeFace, u: number, v: number): Vec3 {
  if (!Number.isInteger(face) || face < 0 || face >= FACE_COUNT) {
    throw new Error(`Terrain node face must be an integer from 0 to 5, received ${face}`);
  }
  if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error('Face UV coordinates must be finite');
  return spherifyCubeCoordinates(cubeFaceCoordinates(face, 2 * u - 1, 2 * v - 1));
}

function faceRatios(face: CubeFace, direction: Vec3): readonly [number, number] {
  const [x, y, z] = direction;
  switch (face) {
    case 0: return [-z / x, y / x];
    case 1: return [z / -x, y / -x];
    case 2: return [x / y, -z / y];
    case 3: return [x / -y, z / -y];
    case 4: return [x / z, y / z];
    case 5: return [-x / -z, y / -z];
  }
}

function inverseSpherifiedFaceCoordinates(face: CubeFace, direction: Vec3): readonly [number, number] {
  const desired = faceRatios(face, direction);
  let s = clamp(desired[0], -1, 1);
  let t = clamp(desired[1], -1, 1);

  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const currentDirection = spherifyCubeCoordinates(cubeFaceCoordinates(face, s, t));
    const current = faceRatios(face, currentDirection);
    const errorS = desired[0] - current[0];
    const errorT = desired[1] - current[1];
    if (Math.abs(errorS) + Math.abs(errorT) < 1e-12) break;

    const sDirection = spherifyCubeCoordinates(cubeFaceCoordinates(face, s + NEWTON_EPSILON, t));
    const tDirection = spherifyCubeCoordinates(cubeFaceCoordinates(face, s, t + NEWTON_EPSILON));
    const sRatios = faceRatios(face, sDirection);
    const tRatios = faceRatios(face, tDirection);
    const j00 = (sRatios[0] - current[0]) / NEWTON_EPSILON;
    const j01 = (tRatios[0] - current[0]) / NEWTON_EPSILON;
    const j10 = (sRatios[1] - current[1]) / NEWTON_EPSILON;
    const j11 = (tRatios[1] - current[1]) / NEWTON_EPSILON;
    const determinant = j00 * j11 - j01 * j10;
    if (Math.abs(determinant) < 1e-12) break;
    s = clamp(s + (errorS * j11 - errorT * j01) / determinant, -1, 1);
    t = clamp(t + (j00 * errorT - j10 * errorS) / determinant, -1, 1);
  }
  return [s, t];
}

function dominantFace(direction: Vec3): CubeFace {
  const [x, y, z] = direction;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  // Fixed X, then Y, then Z priority makes edge/corner ownership stable.
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

export interface FaceUv {
  readonly face: CubeFace;
  readonly u: number;
  readonly v: number;
}

export function directionToFaceUv(direction: Vec3): FaceUv {
  const normalized = normalize(direction);
  const face = dominantFace(normalized);
  const [s, t] = inverseSpherifiedFaceCoordinates(face, normalized);
  return { face, u: (s + 1) / 2, v: (t + 1) / 2 };
}

export function addressFromFaceUv(face: CubeFace, u: number, v: number, level: number): TerrainNodeAddress {
  const count = nodeCount(level);
  if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error('Face UV coordinates must be finite');
  return {
    face,
    level,
    x: Math.min(count - 1, Math.max(0, Math.floor(u * count))),
    y: Math.min(count - 1, Math.max(0, Math.floor(v * count))),
  };
}

export function addressFromDirection(direction: Vec3, level: number): TerrainNodeAddress {
  const faceUv = directionToFaceUv(direction);
  return addressFromFaceUv(faceUv.face, faceUv.u, faceUv.v, level);
}

export function nodeCenterDirection(address: TerrainNodeAddress): Vec3 {
  const [u, v] = nodeCenterFaceUv(address);
  return faceUvToDirection(address.face, u, v);
}

export function nodeAngularRadiusRadians(address: TerrainNodeAddress): number {
  const bounds = nodeUvBounds(address);
  const center = nodeCenterDirection(address);
  return Math.max(
    angularDistance(center, faceUvToDirection(address.face, bounds.uMin, bounds.vMin)),
    angularDistance(center, faceUvToDirection(address.face, bounds.uMax, bounds.vMin)),
    angularDistance(center, faceUvToDirection(address.face, bounds.uMin, bounds.vMax)),
    angularDistance(center, faceUvToDirection(address.face, bounds.uMax, bounds.vMax)),
  );
}

export function nodeGeometricErrorM(address: TerrainNodeAddress, planetRadiusM = SKY_DERIVED.earthRadiusM): number {
  validateNodeAddress(address);
  if (!Number.isFinite(planetRadiusM) || planetRadiusM <= 0) throw new Error('Planet radius must be positive');
  return planetRadiusM * 2 ** -address.level;
}

export function nodeScreenSpaceErrorPx(
  address: TerrainNodeAddress,
  cameraPosition: Vec3,
  options: Pick<TerrainLodOptions, 'planetRadiusM' | 'projectionScalePx'> = {},
): number {
  validateNodeAddress(address);
  assertFiniteVector(cameraPosition);
  const planetRadiusM = options.planetRadiusM ?? SKY_DERIVED.earthRadiusM;
  const projectionScalePx = options.projectionScalePx ?? 1;
  if (!Number.isFinite(projectionScalePx) || projectionScalePx < 0) throw new Error('Projection scale must be non-negative');
  const center = nodeCenterDirection(address);
  const centerPosition: Vec3 = [center[0] * planetRadiusM, center[1] * planetRadiusM, center[2] * planetRadiusM];
  const distance = Math.max(
    Math.hypot(
      cameraPosition[0] - centerPosition[0],
      cameraPosition[1] - centerPosition[1],
      cameraPosition[2] - centerPosition[2],
    ),
    1e-6,
  );
  return (nodeGeometricErrorM(address, planetRadiusM) / distance) * projectionScalePx;
}

export function decideLod(
  address: TerrainNodeAddress,
  cameraPosition: Vec3,
  options: TerrainLodOptions = {},
): TerrainLodDecision {
  const screenSpaceErrorPx = nodeScreenSpaceErrorPx(address, cameraPosition, options);
  const splitThresholdPx = options.splitThresholdPx ?? TERRAIN_SPLIT_SCREEN_SPACE_ERROR_PX;
  const mergeThresholdPx = options.mergeThresholdPx ?? splitThresholdPx * 0.5;
  const maxLevel = options.maxLevel ?? 24;
  if (!Number.isFinite(splitThresholdPx) || splitThresholdPx < 0) throw new Error('Split threshold must be non-negative');
  if (!Number.isFinite(mergeThresholdPx) || mergeThresholdPx < 0) throw new Error('Merge threshold must be non-negative');
  if (address.level < maxLevel && screenSpaceErrorPx > splitThresholdPx) {
    return { action: 'split', screenSpaceErrorPx };
  }
  if (address.level > 0 && screenSpaceErrorPx < mergeThresholdPx) {
    return { action: 'merge', screenSpaceErrorPx };
  }
  return { action: 'keep', screenSpaceErrorPx };
}

function edgeIsInterior(address: TerrainNodeAddress, edge: TerrainEdge, count: number): boolean {
  return (edge === 'west' && address.x > 0)
    || (edge === 'east' && address.x + 1 < count)
    || (edge === 'south' && address.y > 0)
    || (edge === 'north' && address.y + 1 < count);
}

function addressFromOutsideCubeFaceSample(
  face: CubeFace,
  u: number,
  v: number,
  level: number,
): TerrainNodeAddress {
  // Use the unspherified sample only to establish which adjacent face owns
  // an outside point. The shared boundary itself is the same cube vector on
  // both faces, so this avoids a floating-point tie at a spherified seam.
  const rawDirection = normalize(cubeFaceCoordinates(face, 2 * u - 1, 2 * v - 1));
  const targetFace = dominantFace(rawDirection);
  const [s, t] = faceRatios(targetFace, rawDirection);
  return addressFromFaceUv(targetFace, (s + 1) / 2, (t + 1) / 2, level);
}

export function neighborAddress(address: TerrainNodeAddress, edge: TerrainEdge): TerrainNodeAddress {
  validateNodeAddress(address);
  const count = nodeCount(address.level);
  if (edgeIsInterior(address, edge, count)) {
    switch (edge) {
      case 'north': return { ...address, y: address.y + 1 };
      case 'east': return { ...address, x: address.x + 1 };
      case 'south': return { ...address, y: address.y - 1 };
      case 'west': return { ...address, x: address.x - 1 };
    }
  }

  const center = nodeCenterFaceUv(address);
  let u = center[0];
  let v = center[1];
  switch (edge) {
    case 'north': v = (address.y + 1 + FACE_EPSILON) / count; break;
    case 'east': u = (address.x + 1 + FACE_EPSILON) / count; break;
    case 'south': v = (address.y - FACE_EPSILON) / count; break;
    case 'west': u = (address.x - FACE_EPSILON) / count; break;
  }
  return addressFromOutsideCubeFaceSample(address.face, u, v, address.level);
}

export function skirtMetadata(
  address: TerrainNodeAddress,
  depthM = TERRAIN_SKIRT_DEPTH_M,
): readonly TerrainSkirtMetadata[] {
  validateNodeAddress(address);
  if (!Number.isFinite(depthM) || depthM < 0) throw new Error('Skirt depth must be non-negative');
  return EDGE_ORDER.map((edge) => ({
    edge,
    neighbor: neighborAddress(address, edge),
    depthM,
  }));
}

export const TERRAIN_EDGES = EDGE_ORDER;

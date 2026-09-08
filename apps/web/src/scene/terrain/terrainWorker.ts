import {
  faceUvToDirection,
  neighborAddress,
  parentAddress,
  TERRAIN_EDGES,
  nodeAddressKey,
  nodeCenterFaceUv,
  nodeUvBounds,
  validateNodeAddress,
  type TerrainNodeAddress,
  type Vec3,
} from './quadtree';
import {
  height,
  residentTileMap,
  validateTerrainRgbCodec,
  type DetailNoiseOptions,
  type HeroRegionConfig,
  type TerrainRgbCodec,
  type TerrainTile,
} from './heightField';
import { TERRAIN_SKIRT_DEPTH_M, SKY_DERIVED } from '../sky/skyConfig';

const GRID_SEGMENTS = 32;
const GRID_SIZE = GRID_SEGMENTS + 1;

/**
 * Required base inputs at min(geometry LOD, raster LOD), including the tiles
 * owning boundary vertices. Deep geometry must never wait for nonexistent
 * raster levels. The owner also waits for ancestors used as no-data fallbacks.
 */
export function requiredPatchTileAddresses(address: TerrainNodeAddress, rasterMaxLevel: number): readonly TerrainNodeAddress[] {
  if (!Number.isSafeInteger(rasterMaxLevel) || rasterMaxLevel < 0) throw new Error('Invalid raster max level');
  let tile = address;
  while (tile.level > rasterMaxLevel) tile = parentAddress(tile)!;
  const required = new Map([[nodeAddressKey(tile), tile]]);
  const bounds = nodeUvBounds(address);
  const rasterBounds = nodeUvBounds(tile);
  const touches = {
    west: bounds.uMin === rasterBounds.uMin,
    east: bounds.uMax === rasterBounds.uMax,
    south: bounds.vMin === rasterBounds.vMin,
    north: bounds.vMax === rasterBounds.vMax,
  };
  for (const edge of TERRAIN_EDGES) if (touches[edge]) {
    const adjacent = neighborAddress(tile, edge);
    required.set(nodeAddressKey(adjacent), adjacent);
    if (adjacent.face !== tile.face) {
      // At either endpoint of a cube seam, inverse-coordinate rounding can
      // assign the corner to the next tile along the adjacent face. Include
      // that face's immediate neighbors as well (still a bounded footprint).
      for (const adjacentEdge of TERRAIN_EDGES) {
        const cornerOwner = neighborAddress(adjacent, adjacentEdge);
        required.set(nodeAddressKey(cornerOwner), cornerOwner);
      }
    }
  }
  // Same-face corners may be owned by a diagonal tile. Cube corners' other
  // two faces are already covered by the two edge neighbors above.
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
    if (!touches[dx < 0 ? 'west' : 'east'] || !touches[dy < 0 ? 'south' : 'north']) continue;
    const x = tile.x + dx;
    const y = tile.y + dy;
    if (x < 0 || y < 0 || x >= 2 ** tile.level || y >= 2 ** tile.level) continue;
    const diagonal = { ...tile, x, y };
    required.set(nodeAddressKey(diagonal), diagonal);
  }
  return [...required.values()];
}

export interface PatchHeroRegionConfig {
  readonly id: string;
  readonly centerLatDeg: number;
  readonly centerLonDeg: number;
  readonly radiusKm: number;
  readonly featherKm: number;
  readonly manifestUrl?: string;
}

export type HeroHeightSampler = (latRad: number, lonRad: number) => number | null;

/** A hero DEM tile's own lat/lon footprint (degrees) within its region's local-equirectangular pyramid. */
export interface PatchHeroTileBounds {
  readonly minLatDeg: number;
  readonly maxLatDeg: number;
  readonly minLonDeg: number;
  readonly maxLonDeg: number;
}

/**
 * Raw decoded hero DEM pixel data, gathered on the main thread (which owns
 * the resident hero-tile cache) and structured-cloned to the worker — a
 * sampler FUNCTION cannot cross that boundary, so the worker builds its own
 * sampler from this data instead of receiving one.
 */
export interface PatchHeroTile {
  readonly regionId: string;
  /** Square tile edge length in pixels; data.length === tileSize * tileSize. */
  readonly tileSize: number;
  readonly bounds: PatchHeroTileBounds;
  /** Decoded metres. NaN entries are the reserved terrain-RGB no-data value. */
  readonly data: Float32Array;
}

export interface PatchBuildRequest {
  readonly type: 'buildPatch';
  readonly requestId?: number;
  readonly address: TerrainNodeAddress;
  /** Request-scoped structured-clone data; workers do not own a persistent tile cache. */
  readonly tiles: readonly TerrainTile[];
  readonly codec: TerrainRgbCodec;
  readonly heroRegions?: readonly PatchHeroRegionConfig[];
  /** Resident hero DEM tiles overlapping this patch, keyed loosely by regionId. */
  readonly heroTiles?: readonly PatchHeroTile[];
  readonly detail?: Partial<DetailNoiseOptions>;
  readonly planetRadiusM?: number;
  readonly skirtDepthM?: number;
}

export interface PatchBuildResult {
  readonly type: 'patchBuilt';
  readonly requestId?: number;
  readonly address: TerrainNodeAddress;
  /** Absolute planet-centred metres, retained as f64 on the CPU side. */
  readonly patchCenterF64: readonly [number, number, number];
  /** All geometry buffers are patch-centre-relative and ready for transfer. */
  readonly positions: ArrayBuffer;
  readonly normals: ArrayBuffer;
  readonly uvs: ArrayBuffer;
  readonly indices: ArrayBuffer;
  /** Uint8 per vertex: 1 = source height <= 0, before RTC Float32 rounding. Skirts inherit their base vertex. */
  readonly waterMask: ArrayBuffer;
  /** RTC geoid positions built from original f64 directions; zero-height base vertices exactly match positions. */
  readonly waterPositions: ArrayBuffer;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly baseVertexCount: number;
  readonly skirtVertexCount: number;
  readonly boundingSphereRadiusM: number;
}

export interface PatchBuildError {
  readonly type: 'patchBuildError';
  readonly requestId?: number;
  readonly message: string;
}

export type TerrainWorkerMessage = PatchBuildResult | PatchBuildError;

export interface PatchBuildOptions {
  /** Pure-only seam for tests and future hero-tile integration. */
  readonly heroSamplers?: Readonly<Record<string, HeroHeightSampler>>;
}

interface VertexSample {
  readonly water: boolean;
  readonly waterAbsolute: Vec3;
  readonly direction: Vec3;
  readonly absolute: Vec3;
  readonly uv: readonly [number, number];
}

interface OutputVertex {
  readonly water: boolean;
  readonly waterAbsolute: Vec3;
  readonly absolute: Vec3;
  readonly normal: Vec3;
  readonly uv: readonly [number, number];
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length === 0) return [0, 1, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function latLonFromDirection(direction: Vec3): readonly [number, number] {
  // Exact inverse of heightField's directionFromLatLon (lon 0 at +X,
  // z = -sin(lon)): lon = atan2(-z, x).
  return [Math.asin(Math.max(-1, Math.min(1, direction[1]))), Math.atan2(-direction[2], direction[0])];
}

function absolutePosition(direction: Vec3, heightM: number, planetRadiusM: number): Vec3 {
  const radius = planetRadiusM + heightM;
  return [direction[0] * radius, direction[1] * radius, direction[2] * radius];
}

function validateRequest(request: PatchBuildRequest, planetRadiusM: number, skirtDepthM: number): void {
  if (request.type !== 'buildPatch') throw new Error(`Unsupported terrain worker message: ${request.type}`);
  validateNodeAddress(request.address);
  validateTerrainRgbCodec(request.codec);
  if (!Number.isFinite(planetRadiusM) || planetRadiusM <= 0) throw new Error('Patch planet radius must be positive');
  if (!Number.isFinite(skirtDepthM) || skirtDepthM < 0) throw new Error('Patch skirt depth must be non-negative');
  for (const tile of request.tiles) {
    validateNodeAddress(tile.address);
    if (tile.codec.offsetM !== request.codec.offsetM || tile.codec.scaleM !== request.codec.scaleM) {
      throw new Error(`Tile ${nodeAddressKey(tile.address)} codec does not match the patch manifest codec`);
    }
  }
  for (const heroTile of request.heroTiles ?? []) {
    if (!Number.isSafeInteger(heroTile.tileSize) || heroTile.tileSize < 1) {
      throw new Error(`Hero tile for region ${heroTile.regionId} must have a positive integer tileSize`);
    }
    const { minLatDeg, maxLatDeg, minLonDeg, maxLonDeg } = heroTile.bounds;
    if (![minLatDeg, maxLatDeg, minLonDeg, maxLonDeg].every(Number.isFinite)
      || minLatDeg >= maxLatDeg || minLonDeg >= maxLonDeg) {
      throw new Error(`Hero tile for region ${heroTile.regionId} has invalid bounds`);
    }
    if (heroTile.data.length !== heroTile.tileSize * heroTile.tileSize) {
      throw new Error(`Hero tile for region ${heroTile.regionId} data length does not match tileSize`);
    }
  }
}

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Bilinear lookup against one hero DEM tile's raw pixel data, mirroring
 * heightField.ts's own tileSample but for a tile addressed by lat/lon
 * bounds (the hero pyramid's local-equirectangular projection) rather than
 * cube-face UV bounds.
 */
function sampleHeroTile(tile: PatchHeroTile, latDeg: number, lonDeg: number): number | null {
  const { minLatDeg, maxLatDeg, minLonDeg, maxLonDeg } = tile.bounds;
  if (latDeg < minLatDeg || latDeg > maxLatDeg || lonDeg < minLonDeg || lonDeg > maxLonDeg) return null;
  const u = (lonDeg - minLonDeg) / (maxLonDeg - minLonDeg);
  const v = (maxLatDeg - latDeg) / (maxLatDeg - minLatDeg);
  const x = u * (tile.tileSize - 1);
  const y = v * (tile.tileSize - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, tile.tileSize - 1);
  const y1 = Math.min(y0 + 1, tile.tileSize - 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix: number, iy: number): number | null => {
    const value = tile.data[iy * tile.tileSize + ix];
    return Number.isFinite(value) ? value : null;
  };
  const topLeft = at(x0, y0);
  const topRight = at(x1, y0);
  const bottomLeft = at(x0, y1);
  const bottomRight = at(x1, y1);
  if (topLeft === null || topRight === null || bottomLeft === null || bottomRight === null) return null;
  const top = topLeft * (1 - tx) + topRight * tx;
  const bottom = bottomLeft * (1 - tx) + bottomRight * tx;
  return top * (1 - ty) + bottom * ty;
}

function heroTileSampler(tiles: readonly PatchHeroTile[]): HeroHeightSampler {
  return (latRad, lonRad) => {
    const latDeg = latRad * RAD_TO_DEG;
    const lonDeg = lonRad * RAD_TO_DEG;
    for (const tile of tiles) {
      const value = sampleHeroTile(tile, latDeg, lonDeg);
      if (value !== null) return value;
    }
    return null;
  };
}

function makeHeightField(request: PatchBuildRequest, options: PatchBuildOptions): Parameters<typeof height>[2] {
  const tileMap = new Map(request.tiles.map((tile) => [nodeAddressKey(tile.address), tile]));
  const heroTilesByRegion = new Map<string, PatchHeroTile[]>();
  for (const heroTile of request.heroTiles ?? []) {
    const existing = heroTilesByRegion.get(heroTile.regionId);
    if (existing === undefined) heroTilesByRegion.set(heroTile.regionId, [heroTile]);
    else existing.push(heroTile);
  }
  const heroRegions: readonly HeroRegionConfig[] = (request.heroRegions ?? []).map((region) => {
    // heroSamplers stays a pure-function test seam (a real Worker can never
    // receive one over postMessage); the real runtime path always derives
    // the sampler from the raw heroTiles data instead.
    const injected = options.heroSamplers?.[region.id];
    const regionTiles = heroTilesByRegion.get(region.id);
    return {
      ...region,
      sample: injected ?? (regionTiles !== undefined ? heroTileSampler(regionTiles) : () => null),
    };
  });
  return {
    tiles: residentTileMap(tileMap),
    level: request.address.level,
    detail: request.detail,
    heroRegions,
  };
}

/**
 * Builds one patch without any worker or renderer dependency. All logical
 * positions remain f64 until subtraction from the f64 patch centre; only the
 * resulting local geometry is stored in f32 buffers.
 */
export function buildPatchGeometry(request: PatchBuildRequest, options: PatchBuildOptions = {}): PatchBuildResult {
  const planetRadiusM = request.planetRadiusM ?? SKY_DERIVED.earthRadiusM;
  const skirtDepthM = request.skirtDepthM ?? TERRAIN_SKIRT_DEPTH_M;
  validateRequest(request, planetRadiusM, skirtDepthM);
  const field = makeHeightField(request, options);
  const bounds = nodeUvBounds(request.address);
  const nodeCenterUv = nodeCenterFaceUv(request.address);
  const centerDirection = faceUvToDirection(request.address.face, nodeCenterUv[0], nodeCenterUv[1]);
  const [centerLat, centerLon] = latLonFromDirection(centerDirection);
  const centerHeight = height(centerLat, centerLon, field) ?? 0;
  const patchCenterF64 = absolutePosition(centerDirection, centerHeight, planetRadiusM);

  const samples: VertexSample[] = [];
  for (let y = 0; y <= GRID_SEGMENTS; y += 1) {
    for (let x = 0; x <= GRID_SEGMENTS; x += 1) {
      const u = bounds.uMin + (bounds.uMax - bounds.uMin) * (x / GRID_SEGMENTS);
      const v = bounds.vMin + (bounds.vMax - bounds.vMin) * (y / GRID_SEGMENTS);
      const direction = faceUvToDirection(request.address.face, u, v);
      const [lat, lon] = latLonFromDirection(direction);
      const sampleHeight = height(lat, lon, field) ?? 0;
      const absolute = absolutePosition(direction, sampleHeight, planetRadiusM);
      samples.push({
        water: sampleHeight <= 0,
        // Reuse exactly the same f64 position at sea level. Reprojecting RTC
        // Float32 terrain later can put water below the soil it must cover.
        waterAbsolute: sampleHeight < 0 ? absolutePosition(direction, 0, planetRadiusM) : absolute,
        direction,
        absolute,
        uv: [u, v],
      });
    }
  }

  const baseNormals: Vec3[] = [];
  for (let y = 0; y <= GRID_SEGMENTS; y += 1) {
    for (let x = 0; x <= GRID_SEGMENTS; x += 1) {
      const left = samples[y * GRID_SIZE + Math.max(0, x - 1)].absolute;
      const right = samples[y * GRID_SIZE + Math.min(GRID_SEGMENTS, x + 1)].absolute;
      const down = samples[Math.max(0, y - 1) * GRID_SIZE + x].absolute;
      const up = samples[Math.min(GRID_SEGMENTS, y + 1) * GRID_SIZE + x].absolute;
      const finiteDifferenceNormal = normalize(cross(subtract(right, left), subtract(up, down)));
      const radial = samples[y * GRID_SIZE + x].direction;
      const normal = finiteDifferenceNormal[0] === 0 && finiteDifferenceNormal[1] === 1 && finiteDifferenceNormal[2] === 0
        ? radial
        : finiteDifferenceNormal;
      baseNormals.push(normal);
    }
  }

  const outputVertices: OutputVertex[] = samples.map((sample, index) => ({
    water: sample.water,
    waterAbsolute: sample.waterAbsolute,
    absolute: sample.absolute,
    normal: baseNormals[index],
    uv: sample.uv,
  }));
  const skirtEdgeIndices: Array<{ base: number[]; skirt: number[] }> = [];
  const edgeDefinitions = [
    () => Array.from({ length: GRID_SIZE }, (_, index) => GRID_SEGMENTS * GRID_SIZE + index),
    () => Array.from({ length: GRID_SIZE }, (_, index) => index * GRID_SIZE + GRID_SEGMENTS),
    () => Array.from({ length: GRID_SIZE }, (_, index) => index),
    () => Array.from({ length: GRID_SIZE }, (_, index) => index * GRID_SIZE),
  ];
  for (const edge of edgeDefinitions) {
    const base = edge();
    const skirt: number[] = [];
    for (const baseIndex of base) {
      const sample = samples[baseIndex];
      const radial = normalize(sample.absolute);
      const distance = Math.hypot(sample.absolute[0], sample.absolute[1], sample.absolute[2]);
      const skirtAbsolute: Vec3 = [
        radial[0] * (distance - skirtDepthM),
        radial[1] * (distance - skirtDepthM),
        radial[2] * (distance - skirtDepthM),
      ];
      skirt.push(outputVertices.length);
      outputVertices.push({
        water: sample.water,
        waterAbsolute: sample.water ? sample.waterAbsolute : skirtAbsolute,
        absolute: skirtAbsolute, normal: baseNormals[baseIndex], uv: sample.uv,
      });
    }
    skirtEdgeIndices.push({ base, skirt });
  }

  const indexValues: number[] = [];
  for (let y = 0; y < GRID_SEGMENTS; y += 1) {
    for (let x = 0; x < GRID_SEGMENTS; x += 1) {
      const topLeft = y * GRID_SIZE + x;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + GRID_SIZE;
      const bottomRight = bottomLeft + 1;
      indexValues.push(topLeft, topRight, bottomRight, topLeft, bottomRight, bottomLeft);
    }
  }
  for (const [edgeIndex, edge] of skirtEdgeIndices.entries()) {
    for (let index = 0; index < GRID_SEGMENTS; index += 1) {
      const a = edge.base[index];
      const b = edge.base[index + 1];
      const sa = edge.skirt[index];
      const sb = edge.skirt[index + 1];
      if (edgeIndex === 0 || edgeIndex === 1) indexValues.push(a, b, sb, a, sb, sa);
      else indexValues.push(b, a, sa, b, sa, sb);
    }
  }

  const positions = new Float32Array(outputVertices.length * 3);
  const waterPositions = new Float32Array(outputVertices.length * 3);
  const normals = new Float32Array(outputVertices.length * 3);
  const uvs = new Float32Array(outputVertices.length * 2);
  const waterMask = new Uint8Array(outputVertices.length);
  let boundingSphereRadiusM = 0;
  for (let index = 0; index < outputVertices.length; index += 1) {
    const vertex = outputVertices[index];
    waterMask[index] = vertex.water ? 1 : 0;
    const positionOffset = index * 3;
    const local = subtract(vertex.absolute, patchCenterF64);
    positions[positionOffset] = local[0];
    positions[positionOffset + 1] = local[1];
    positions[positionOffset + 2] = local[2];
    const waterLocal = subtract(vertex.waterAbsolute, patchCenterF64);
    waterPositions[positionOffset] = waterLocal[0];
    waterPositions[positionOffset + 1] = waterLocal[1];
    waterPositions[positionOffset + 2] = waterLocal[2];
    boundingSphereRadiusM = Math.max(
      boundingSphereRadiusM,
      Math.hypot(positions[positionOffset], positions[positionOffset + 1], positions[positionOffset + 2]),
    );
    normals[positionOffset] = vertex.normal[0];
    normals[positionOffset + 1] = vertex.normal[1];
    normals[positionOffset + 2] = vertex.normal[2];
    const uvOffset = index * 2;
    uvs[uvOffset] = vertex.uv[0];
    uvs[uvOffset + 1] = vertex.uv[1];
  }

  const indices = new Uint32Array(indexValues);
  return {
    type: 'patchBuilt',
    requestId: request.requestId,
    address: request.address,
    patchCenterF64,
    positions: positions.buffer as ArrayBuffer,
    normals: normals.buffer as ArrayBuffer,
    uvs: uvs.buffer as ArrayBuffer,
    indices: indices.buffer as ArrayBuffer,
    waterMask: waterMask.buffer as ArrayBuffer,
    waterPositions: waterPositions.buffer as ArrayBuffer,
    vertexCount: outputVertices.length,
    indexCount: indices.length,
    baseVertexCount: GRID_SIZE * GRID_SIZE,
    skirtVertexCount: outputVertices.length - GRID_SIZE * GRID_SIZE,
    boundingSphereRadiusM,
  };
}

/** Reject malformed/old worker results rather than reconstructing a noisy sign. */
export function patchWaterMask(result: PatchBuildResult): Uint8Array {
  if (!(result.waterMask instanceof ArrayBuffer) || result.waterMask.byteLength !== result.vertexCount) {
    throw new Error('Terrain water mask must contain one byte per vertex');
  }
  const mask = new Uint8Array(result.waterMask);
  if (mask.some((value) => value !== 0 && value !== 1)) throw new Error('Terrain water mask must be binary');
  return mask;
}

export function patchWaterPositions(result: PatchBuildResult): Float32Array {
  if (!(result.waterPositions instanceof ArrayBuffer)
    || result.waterPositions.byteLength !== result.vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('Terrain water positions must contain three floats per vertex');
  }
  const positions = new Float32Array(result.waterPositions);
  if (positions.some((value) => !Number.isFinite(value))) throw new Error('Terrain water positions must be finite');
  return positions;
}

export function patchBuildTransferables(result: PatchBuildResult): Transferable[] {
  patchWaterMask(result);
  patchWaterPositions(result);
  return [result.positions, result.normals, result.uvs, result.indices, result.waterMask, result.waterPositions];
}

export interface TerrainWorkerScope {
  onmessage: ((event: MessageEvent<PatchBuildRequest>) => void) | null;
  postMessage(message: TerrainWorkerMessage, transfer?: Transferable[]): void;
}

export function createTerrainWorkerMessageHandler(
  postMessage: (message: TerrainWorkerMessage, transfer?: Transferable[]) => void,
  builder: (request: PatchBuildRequest) => PatchBuildResult = buildPatchGeometry,
): (event: MessageEvent<PatchBuildRequest>) => void {
  return (event: MessageEvent<PatchBuildRequest>): void => {
    const request = event.data;
    try {
      const result = builder(request);
      postMessage(result, patchBuildTransferables(result));
    } catch (error) {
      const failure: PatchBuildError = {
        type: 'patchBuildError',
        requestId: request?.requestId,
        message: error instanceof Error ? error.message : String(error),
      };
      postMessage(failure);
    }
  };
}

const isDedicatedWorker = typeof self !== 'undefined' && typeof document === 'undefined';
if (isDedicatedWorker) {
  const workerScope = self as unknown as TerrainWorkerScope;
  workerScope.onmessage = createTerrainWorkerMessageHandler((message, transfer) => workerScope.postMessage(message, transfer));
}

export interface TerrainWorkerLike {
  onmessage: ((event: MessageEvent<TerrainWorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: PatchBuildRequest): void;
  terminate(): void;
}

export interface TerrainWorkerPoolOptions {
  readonly workerCount?: number;
  /** Maximum number of structured-clone requests simultaneously dispatched. */
  readonly maxConcurrentBuilds?: number;
  readonly workerFactory?: () => TerrainWorkerLike;
}

function defaultWorkerFactory(): TerrainWorkerLike {
  return new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' }) as unknown as TerrainWorkerLike;
}

export class TerrainWorkerPool {
  private readonly workers: TerrainWorkerLike[];
  private readonly workerFactory: () => TerrainWorkerLike;
  private readonly pending = new Map<number, {
    readonly resolve: (result: PatchBuildResult) => void;
    readonly reject: (error: Error) => void;
    readonly workerIndex: number;
  }>();
  private readonly queued: Array<{
    readonly requestId: number;
    readonly request: PatchBuildRequest;
    readonly resolve: (result: PatchBuildResult) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private readonly maxConcurrentBuilds: number;
  private activeBuilds = 0;
  private disposed = false;
  private nextRequestId = 0;
  private nextWorker = 0;

  constructor(options: TerrainWorkerPoolOptions = {}) {
    const requestedCount = options.workerCount ?? Math.min(globalThis.navigator?.hardwareConcurrency ?? 4, 8);
    const workerCount = Math.max(1, Math.min(8, Math.floor(requestedCount)));
    const requestedConcurrency = options.maxConcurrentBuilds ?? workerCount;
    if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
      throw new Error(`Terrain worker concurrency must be a positive integer, received ${requestedConcurrency}`);
    }
    this.maxConcurrentBuilds = Math.min(workerCount, requestedConcurrency);
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.workers = Array.from({ length: workerCount }, this.workerFactory);
    this.workers.forEach((worker, index) => this.wireWorker(worker, index));
  }

  private wireWorker(worker: TerrainWorkerLike, index: number): void {
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => {
      if (this.disposed) return;
      // Replace the failed worker in place so future round-robin dispatch
      // doesn't keep routing requests to a worker that will never respond
      // again — without this, those patches would be silently starved.
      worker.terminate();
      const replacement = this.workerFactory();
      this.workers[index] = replacement;
      this.wireWorker(replacement, index);
      // Only this worker's own in-flight requests are lost — the other
      // workers' pending builds are untouched, so a single worker error
      // doesn't throw away every other patch currently in flight pool-wide.
      this.handleWorkerError(new Error(event.message || 'Terrain worker failed'), index);
    };
  }

  build(request: Omit<PatchBuildRequest, 'requestId'>): Promise<PatchBuildResult> {
    if (this.disposed) return Promise.reject(new Error('Terrain worker pool disposed'));
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.queued.push({ requestId, request: { ...request, requestId }, resolve, reject });
      this.dispatchQueued();
    });
  }

  buildMany(requests: readonly Omit<PatchBuildRequest, 'requestId'>[]): Promise<readonly PatchBuildResult[]> {
    return Promise.all(requests.map((request) => this.build(request)));
  }

  /** Drop obsolete undispatched work without interrupting unrelated builds. */
  cancelQueued(predicate: (request: PatchBuildRequest) => boolean): void {
    for (let index = this.queued.length - 1; index >= 0; index -= 1) {
      if (!predicate(this.queued[index].request)) continue;
      const [entry] = this.queued.splice(index, 1);
      entry.reject(new Error('Terrain patch request cancelled'));
    }
  }

  dispose(): void {
    this.disposed = true;
    const error = new Error('Terrain worker pool disposed');
    this.handleWorkerError(error);
    for (const worker of this.workers) worker.terminate();
  }

  private handleMessage(message: TerrainWorkerMessage): void {
    if (message.requestId === undefined) return;
    const pending = this.pending.get(message.requestId);
    if (pending === undefined) return;
    this.pending.delete(message.requestId);
    this.activeBuilds -= 1;
    if (message.type === 'patchBuildError') pending.reject(new Error(message.message));
    else {
      try {
        patchWaterMask(message);
        patchWaterPositions(message);
        pending.resolve(message);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.dispatchQueued();
  }

  /**
   * With no `workerIndex` (pool disposal): reject everything, pending and
   * queued. With a `workerIndex` (one worker errored): only that worker's
   * own pending requests are lost — other workers' in-flight builds and
   * the still-undispatched queue are untouched — then resume dispatch so
   * the queue can keep draining onto the now-replaced worker.
   */
  private handleWorkerError(error: Error, workerIndex?: number): void {
    if (workerIndex === undefined) {
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      for (const { reject } of this.queued) reject(error);
      this.queued.length = 0;
      this.activeBuilds = 0;
      return;
    }
    for (const [requestId, entry] of this.pending) {
      if (entry.workerIndex !== workerIndex) continue;
      entry.reject(error);
      this.pending.delete(requestId);
      this.activeBuilds -= 1;
    }
    this.dispatchQueued();
  }

  private dispatchQueued(): void {
    while (this.activeBuilds < this.maxConcurrentBuilds && this.queued.length > 0) {
      const queued = this.queued.shift()!;
      const workerIndex = this.nextWorker++ % this.workers.length;
      const worker = this.workers[workerIndex]!;
      this.pending.set(queued.requestId, { ...queued, workerIndex });
      this.activeBuilds += 1;
      try {
        // Deliberately omit a transfer list: request-scoped tile data remains
        // owned by the caller and is copied only for this bounded dispatch.
        worker.postMessage(queued.request);
      } catch (error) {
        this.pending.delete(queued.requestId);
        this.activeBuilds -= 1;
        queued.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

export const TERRAIN_PATCH_GRID_SIZE = GRID_SIZE;
export const TERRAIN_PATCH_GRID_SEGMENTS = GRID_SEGMENTS;

import {
  faceUvToDirection,
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

export interface PatchHeroRegionConfig {
  readonly id: string;
  readonly centerLatDeg: number;
  readonly centerLonDeg: number;
  readonly radiusKm: number;
  readonly featherKm: number;
  readonly manifestUrl?: string;
}

export type HeroHeightSampler = (latRad: number, lonRad: number) => number | null;

export interface PatchBuildRequest {
  readonly type: 'buildPatch';
  readonly requestId?: number;
  readonly address: TerrainNodeAddress;
  /** Request-scoped structured-clone data; workers do not own a persistent tile cache. */
  readonly tiles: readonly TerrainTile[];
  readonly codec: TerrainRgbCodec;
  readonly heroRegions?: readonly PatchHeroRegionConfig[];
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
  readonly direction: Vec3;
  readonly absolute: Vec3;
  readonly uv: readonly [number, number];
}

interface OutputVertex {
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
}

function makeHeightField(request: PatchBuildRequest, options: PatchBuildOptions): Parameters<typeof height>[2] {
  const tileMap = new Map(request.tiles.map((tile) => [nodeAddressKey(tile.address), tile]));
  const heroRegions: readonly HeroRegionConfig[] = (request.heroRegions ?? []).map((region) => ({
    ...region,
    sample: options.heroSamplers?.[region.id] ?? (() => null),
  }));
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
      samples.push({
        direction,
        absolute: absolutePosition(direction, sampleHeight, planetRadiusM),
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
      outputVertices.push({ absolute: skirtAbsolute, normal: baseNormals[baseIndex], uv: sample.uv });
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
  const normals = new Float32Array(outputVertices.length * 3);
  const uvs = new Float32Array(outputVertices.length * 2);
  let boundingSphereRadiusM = 0;
  for (let index = 0; index < outputVertices.length; index += 1) {
    const vertex = outputVertices[index];
    const positionOffset = index * 3;
    const local = subtract(vertex.absolute, patchCenterF64);
    positions[positionOffset] = local[0];
    positions[positionOffset + 1] = local[1];
    positions[positionOffset + 2] = local[2];
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
    vertexCount: outputVertices.length,
    indexCount: indices.length,
    baseVertexCount: GRID_SIZE * GRID_SIZE,
    skirtVertexCount: outputVertices.length - GRID_SIZE * GRID_SIZE,
    boundingSphereRadiusM,
  };
}

export function patchBuildTransferables(result: PatchBuildResult): Transferable[] {
  return [result.positions, result.normals, result.uvs, result.indices];
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
  private readonly workers: readonly TerrainWorkerLike[];
  private readonly pending = new Map<number, { resolve: (result: PatchBuildResult) => void; reject: (error: Error) => void }>();
  private readonly queued: Array<{
    readonly requestId: number;
    readonly request: PatchBuildRequest;
    readonly resolve: (result: PatchBuildResult) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private readonly maxConcurrentBuilds: number;
  private activeBuilds = 0;
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
    const factory = options.workerFactory ?? defaultWorkerFactory;
    const workers = Array.from({ length: workerCount }, factory);
    for (const worker of workers) {
      worker.onmessage = (event) => this.handleMessage(event.data);
      worker.onerror = (event) => this.handleWorkerError(new Error(event.message || 'Terrain worker failed'));
    }
    this.workers = workers;
  }

  build(request: Omit<PatchBuildRequest, 'requestId'>): Promise<PatchBuildResult> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.queued.push({ requestId, request: { ...request, requestId }, resolve, reject });
      this.dispatchQueued();
    });
  }

  buildMany(requests: readonly Omit<PatchBuildRequest, 'requestId'>[]): Promise<readonly PatchBuildResult[]> {
    return Promise.all(requests.map((request) => this.build(request)));
  }

  dispose(): void {
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
    else pending.resolve(message);
    this.dispatchQueued();
  }

  private handleWorkerError(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const { reject } of this.queued) reject(error);
    this.queued.length = 0;
    this.activeBuilds = 0;
  }

  private dispatchQueued(): void {
    while (this.activeBuilds < this.maxConcurrentBuilds && this.queued.length > 0) {
      const queued = this.queued.shift()!;
      const worker = this.workers[this.nextWorker++ % this.workers.length];
      this.pending.set(queued.requestId, queued);
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

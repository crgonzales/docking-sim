import { describe, expect, it } from 'vitest';
import { SKY_DERIVED } from '../sky/skyConfig';
import { addressFromDirection, faceUvToDirection, nodeUvBounds, nodeAddressKey, type TerrainNodeAddress } from './quadtree';
import {
  DEFAULT_TERRAIN_RGB_CODEC,
  directionFromLatLon,
  height,
  residentTileMap,
  type TerrainTile,
} from './heightField';
import {
  buildPatchGeometry,
  requiredPatchTileAddresses,
  patchBuildTransferables,
  patchWaterMask,
  patchWaterPositions,
  createTerrainWorkerMessageHandler,
  TerrainWorkerPool,
  TERRAIN_PATCH_GRID_SIZE,
  type PatchBuildRequest,
  type PatchBuildResult,
  type PatchHeroTile,
  type TerrainWorkerMessage,
  type TerrainWorkerLike,
} from './terrainWorker';

function tile(address: TerrainNodeAddress, value: number): TerrainTile {
  return {
    address,
    width: 1,
    height: 1,
    codec: DEFAULT_TERRAIN_RGB_CODEC,
    data: new Float32Array([value]),
    byteLength: 4,
  };
}

function worldTiles(value: number, extra: TerrainTile[] = []): TerrainTile[] {
  const tiles = [0, 1, 2, 3, 4, 5].map((face) => tile({ face: face as 0 | 1 | 2 | 3 | 4 | 5, level: 0, x: 0, y: 0 }, value));
  return [...tiles, ...extra];
}

function request(address: TerrainNodeAddress, tiles = worldTiles(100), overrides: Partial<PatchBuildRequest> = {}): PatchBuildRequest {
  return {
    type: 'buildPatch',
    address,
    tiles,
    codec: DEFAULT_TERRAIN_RGB_CODEC,
    detail: { baseAmplitudeM: 0 },
    skirtDepthM: 7,
    ...overrides,
  };
}

function absoluteVertex(result: PatchBuildResult, index: number): readonly [number, number, number] {
  const positions = new Float32Array(result.positions);
  const offset = index * 3;
  return [
    result.patchCenterF64[0] + positions[offset],
    result.patchCenterF64[1] + positions[offset + 1],
    result.patchCenterF64[2] + positions[offset + 2],
  ];
}

describe('terrain worker patch builder', () => {
  it('matches height() at sampled patch vertices', () => {
    const address: TerrainNodeAddress = { face: 0, level: 20, x: 2 ** 19, y: 2 ** 19 };
    const buildRequest = request(address, worldTiles(100, [tile(address, 100)]));
    const result = buildPatchGeometry(buildRequest);
    const positions = new Float32Array(result.positions);
    const field = {
      tiles: residentTileMap(new Map(buildRequest.tiles.map((entry) => [nodeAddressKey(entry.address), entry]))),
      level: address.level,
      detail: { baseAmplitudeM: 0 },
    };
    for (const index of [0, 16, 32, 528, 544, 560, 1056, 1072, 1088]) {
      const absolute = absoluteVertex(result, index);
      const radius = Math.hypot(absolute[0], absolute[1], absolute[2]);
      const direction: [number, number, number] = [absolute[0] / radius, absolute[1] / radius, absolute[2] / radius];
      const lat = Math.asin(direction[1]);
      const lon = Math.atan2(-direction[2], direction[0]);
      expect(radius - SKY_DERIVED.earthRadiusM).toBeCloseTo(height(lat, lon, field)!, 3);
    }
    expect(positions.length).toBe(result.vertexCount * 3);
  });

  it('returns a bounding sphere that contains every emitted vertex', () => {
    const result = buildPatchGeometry(request({ face: 4, level: 2, x: 1, y: 2 }));
    const positions = new Float32Array(result.positions);
    for (let index = 0; index < result.vertexCount; index += 1) {
      const offset = index * 3;
      expect(Math.hypot(positions[offset], positions[offset + 1], positions[offset + 2]))
        .toBeLessThanOrEqual(result.boundingSphereRadiusM + 1e-6);
    }
  });

  it('drops skirt vertices below their corresponding edge vertices', () => {
    const result = buildPatchGeometry(request({ face: 0, level: 1, x: 0, y: 0 }));
    const baseCount = TERRAIN_PATCH_GRID_SIZE ** 2;
    const positions = new Float32Array(result.positions);
    const edges = [
      Array.from({ length: TERRAIN_PATCH_GRID_SIZE }, (_, index) => (TERRAIN_PATCH_GRID_SIZE - 1) * TERRAIN_PATCH_GRID_SIZE + index),
      Array.from({ length: TERRAIN_PATCH_GRID_SIZE }, (_, index) => index * TERRAIN_PATCH_GRID_SIZE + TERRAIN_PATCH_GRID_SIZE - 1),
      Array.from({ length: TERRAIN_PATCH_GRID_SIZE }, (_, index) => index),
      Array.from({ length: TERRAIN_PATCH_GRID_SIZE }, (_, index) => index * TERRAIN_PATCH_GRID_SIZE),
    ];
    let skirtIndex = baseCount;
    for (const edge of edges) {
      for (const baseIndex of edge) {
        const baseOffset = baseIndex * 3;
        const skirtOffset = skirtIndex * 3;
        const baseRadius = Math.hypot(
          result.patchCenterF64[0] + positions[baseOffset],
          result.patchCenterF64[1] + positions[baseOffset + 1],
          result.patchCenterF64[2] + positions[baseOffset + 2],
        );
        const skirtRadius = Math.hypot(
          result.patchCenterF64[0] + positions[skirtOffset],
          result.patchCenterF64[1] + positions[skirtOffset + 1],
          result.patchCenterF64[2] + positions[skirtOffset + 2],
        );
        expect(skirtRadius).toBeLessThan(baseRadius);
        skirtIndex += 1;
      }
    }
    expect(skirtIndex).toBe(result.vertexCount);
  });

  it('keeps local RTC positions small for a ground-level high-level node', () => {
    const address: TerrainNodeAddress = { face: 0, level: 20, x: 2 ** 19, y: 2 ** 19 };
    const result = buildPatchGeometry(request(address, worldTiles(100, [tile(address, 100)])));
    const positions = new Float32Array(result.positions);
    let maximum = 0;
    for (let index = 0; index < positions.length; index += 3) {
      maximum = Math.max(maximum, Math.hypot(positions[index], positions[index + 1], positions[index + 2]));
    }
    expect(maximum).toBeLessThan(20);
    expect(result.patchCenterF64.some((value) => Math.abs(value) > 1_000_000)).toBe(true);
  });

  it('blends hero DEM height from raw heroTiles data, matching a fully-covering region', () => {
    // A deep-level, near-ground-size patch (as in the RTC-precision test
    // above) keeps local vertex offsets small so float32 geometry storage
    // doesn't swamp the metre-scale height differences this test asserts.
    const address: TerrainNodeAddress = { face: 0, level: 20, x: 2 ** 19, y: 2 ** 19 };
    const heroTile: PatchHeroTile = {
      regionId: 'test-hero',
      tileSize: 2,
      bounds: { minLatDeg: -90, maxLatDeg: 90, minLonDeg: -180, maxLonDeg: 180 },
      data: Float32Array.of(500, 500, 500, 500),
    };
    const result = buildPatchGeometry(request(address, worldTiles(100, [tile(address, 100)]), {
      heroRegions: [{ id: 'test-hero', centerLatDeg: 0, centerLonDeg: 0, radiusKm: 1_000_000, featherKm: 0 }],
      heroTiles: [heroTile],
    }));
    const positions = new Float32Array(result.positions);
    for (let index = 0; index < TERRAIN_PATCH_GRID_SIZE * TERRAIN_PATCH_GRID_SIZE; index += 1) {
      const offset = index * 3;
      const radius = Math.hypot(
        result.patchCenterF64[0] + positions[offset],
        result.patchCenterF64[1] + positions[offset + 1],
        result.patchCenterF64[2] + positions[offset + 2],
      );
      expect(radius - SKY_DERIVED.earthRadiusM).toBeCloseTo(500, 3);
    }
  });

  it('falls back to base raster height when no heroTiles are supplied for a configured region', () => {
    const address: TerrainNodeAddress = { face: 0, level: 20, x: 2 ** 19, y: 2 ** 19 };
    const result = buildPatchGeometry(request(address, worldTiles(100, [tile(address, 100)]), {
      heroRegions: [{ id: 'test-hero', centerLatDeg: 0, centerLonDeg: 0, radiusKm: 1_000_000, featherKm: 0 }],
    }));
    const positions = new Float32Array(result.positions);
    const radius = Math.hypot(
      result.patchCenterF64[0] + positions[0],
      result.patchCenterF64[1] + positions[1],
      result.patchCenterF64[2] + positions[2],
    );
    expect(radius - SKY_DERIVED.earthRadiusM).toBeCloseTo(100, 3);
  });

  it('requires the finest served base tile while allowing deeper geometry', () => {
    const address: TerrainNodeAddress = { face: 0, level: 10, x: 550, y: 550 };
    const required = requiredPatchTileAddresses(address, 3);
    expect(required).toEqual([{ face: 0, level: 3, x: 4, y: 4 }]);
    const coarse = worldTiles(100);
    const fine = tile(required[0], 500);
    const before = buildPatchGeometry(request(address, coarse));
    const after = buildPatchGeometry(request(address, [...coarse, fine]));
    expect(Math.hypot(...before.patchCenterF64) - SKY_DERIVED.earthRadiusM).toBeCloseTo(100, 5);
    expect(Math.hypot(...after.patchCenterF64) - SKY_DERIVED.earthRadiusM).toBeCloseTo(500, 5);
  });

  it('includes sibling boundary owners and cube-face neighbors in required inputs', () => {
    const seam = requiredPatchTileAddresses({ face: 0, level: 3, x: 7, y: 4 }, 3);
    expect(seam.some((tile) => tile.face !== 0)).toBe(true);
    expect(seam.some((tile) => tile.face === 0 && tile.x === 6 && tile.y === 5)).toBe(true);
    expect(seam.every((tile) => tile.level === 3)).toBe(true);
  });

  it('covers every level-3 boundary vertex owner, including rounded cube-seam corners', () => {
    for (const face of [0, 1, 2, 3, 4, 5] as const) for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      const address = { face, level: 3, x, y };
      const bounds = nodeUvBounds(address);
      const required = new Set(requiredPatchTileAddresses(address, 3).map(nodeAddressKey));
      for (let row = 0; row <= 32; row++) for (let column = 0; column <= 32; column++) {
        if (row !== 0 && row !== 32 && column !== 0 && column !== 32) continue;
        const direction = faceUvToDirection(face,
          bounds.uMin + (bounds.uMax - bounds.uMin) * column / 32,
          bounds.vMin + (bounds.vMax - bounds.vMin) * row / 32);
        // The worker converts via lat/lon before the height field addresses
        // the raster. Reproduce that conversion, including boundary rounding.
        const sampled = directionFromLatLon(Math.asin(direction[1]), Math.atan2(-direction[2], direction[0]));
        expect(required.has(nodeAddressKey(addressFromDirection(sampled, 3)))).toBe(true);
      }
    }
  });

  it('cancels queued work, preserves active work, and rejects builds after disposal', async () => {
    const posted: PatchBuildRequest[] = [];
    const worker: TerrainWorkerLike = {
      onmessage: null, onerror: null,
      postMessage: (message) => { posted.push(message); }, terminate: () => {},
    };
    const pool = new TerrainWorkerPool({ workerCount: 1, workerFactory: () => worker });
    const activeRequest = request({ face: 0, level: 0, x: 0, y: 0 });
    const active = pool.build(activeRequest);
    const cancelled = pool.build(request({ face: 1, level: 0, x: 0, y: 0 }));
    const rejection = expect(cancelled).rejects.toThrow(/cancelled/);
    pool.cancelQueued((build) => build.address.face === 1);
    await rejection;
    expect(posted).toHaveLength(1);
    worker.onmessage?.({ data: buildPatchGeometry({ ...activeRequest, requestId: posted[0].requestId }) } as MessageEvent<TerrainWorkerMessage>);
    await expect(active).resolves.toMatchObject({ type: 'patchBuilt' });
    pool.dispose();
    await expect(pool.build(activeRequest)).rejects.toThrow(/disposed/);
  });

  it('transfers semantic water classification with the geometry buffers', () => {
    const result = buildPatchGeometry(request({ face: 0, level: 3, x: 4, y: 4 }, worldTiles(0)));
    const transfers = patchBuildTransferables(result);
    expect(transfers).toHaveLength(6);
    expect(transfers).toContain(result.waterMask);
    expect(transfers).toContain(result.waterPositions);
    const received = structuredClone(result, { transfer: transfers });
    expect(result.waterMask.byteLength).toBe(0);
    expect(result.waterPositions.byteLength).toBe(0);
    expect(patchWaterMask(received).every((value) => value === 1)).toBe(true);
    expect(patchWaterPositions(received).length).toBe(received.vertexCount * 3);
    expect(new Uint8Array(received.waterPositions, 0, received.baseVertexCount * 12))
      .toEqual(new Uint8Array(received.positions, 0, received.baseVertexCount * 12));
    expect(received.positions.byteLength).toBe(received.vertexCount * 3 * 4);
  });

  it('rejects an old worker result without a mask and still drains the next build', async () => {
    const posted: PatchBuildRequest[] = [];
    const worker: TerrainWorkerLike = {
      onmessage: null, onerror: null,
      postMessage: (message) => { posted.push(message); }, terminate: () => {},
    };
    const pool = new TerrainWorkerPool({ workerCount: 1, workerFactory: () => worker });
    const buildRequest = request({ face: 0, level: 0, x: 0, y: 0 }, worldTiles(0));
    const rejected = expect(pool.build(buildRequest)).rejects.toThrow(/one byte per vertex/);
    const next = pool.build(buildRequest);
    const malformed: PatchBuildResult = { ...buildPatchGeometry(posted[0]), waterMask: undefined! };
    worker.onmessage?.({ data: malformed } as MessageEvent<TerrainWorkerMessage>);
    await rejected;
    expect(posted).toHaveLength(2);
    worker.onmessage?.({ data: buildPatchGeometry(posted[1]) } as MessageEvent<TerrainWorkerMessage>);
    expect(patchWaterMask(await next).every((value) => value === 1)).toBe(true);
    pool.dispose();
  });

  it('round-trips the worker protocol with an injected pure builder', () => {
    const buildRequest = request({ face: 2, level: 1, x: 1, y: 0 }, undefined, { requestId: 42 });
    const messages: Array<PatchBuildResult> = [];
    let injectedCalls = 0;
    const handler = createTerrainWorkerMessageHandler((message) => {
      if (message.type === 'patchBuilt') messages.push(message);
    }, (incoming) => {
      injectedCalls += 1;
      return buildPatchGeometry(incoming);
    });
    handler({ data: buildRequest } as MessageEvent<PatchBuildRequest>);
    expect(injectedCalls).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].requestId).toBe(42);
    expect(messages[0].type).toBe('patchBuilt');
    expect(messages[0].positions).toBeInstanceOf(ArrayBuffer);
  });

  it('bounds structured-clone dispatch and drains queued builds in order', async () => {
    class FakeWorker implements TerrainWorkerLike {
      onmessage: ((event: MessageEvent<TerrainWorkerMessage>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      readonly posted: PatchBuildRequest[] = [];

      postMessage(message: PatchBuildRequest): void {
        this.posted.push(message);
      }

      terminate(): void {}

      complete(requestId: number): void {
        this.onmessage?.({
          data: {
            type: 'patchBuilt',
            requestId,
            address: { face: 0, level: 0, x: 0, y: 0 },
            patchCenterF64: [0, 0, 0],
            positions: new ArrayBuffer(0),
            normals: new ArrayBuffer(0),
            uvs: new ArrayBuffer(0),
            indices: new ArrayBuffer(0),
            waterMask: new ArrayBuffer(0),
            waterPositions: new ArrayBuffer(0),
            vertexCount: 0,
            indexCount: 0,
            baseVertexCount: 0,
            skirtVertexCount: 0,
            boundingSphereRadiusM: 0,
          },
        } as unknown as MessageEvent<TerrainWorkerMessage>);
      }
    }

    const workers: FakeWorker[] = [];
    const pool = new TerrainWorkerPool({
      workerCount: 2,
      maxConcurrentBuilds: 1,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const buildRequest = request({ face: 0, level: 0, x: 0, y: 0 });
    const first = pool.build(buildRequest);
    const second = pool.build(buildRequest);
    const third = pool.build(buildRequest);
    expect(workers[0]?.posted).toHaveLength(1);
    expect(workers[1]?.posted).toHaveLength(0);

    workers[0]!.complete(workers[0]!.posted[0]!.requestId!);
    await first;
    expect(workers[1]?.posted).toHaveLength(1);
    workers[1]!.complete(workers[1]!.posted[0]!.requestId!);
    await second;
    expect(workers[0]?.posted).toHaveLength(2);
    workers[0]!.complete(workers[0]!.posted[1]!.requestId!);
    await third;
    pool.dispose();
  });
});

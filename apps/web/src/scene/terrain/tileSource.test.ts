import { describe, expect, it } from 'vitest';
import { nodeAddressKey, type TerrainNodeAddress } from './quadtree';
import {
  StaleTerrainTileRequestError,
  TerrainTileSource,
  type TerrainFetchResponse,
  type TerrainTileManifest,
} from './tileSource';
import { DEFAULT_TERRAIN_RGB_CODEC, type TerrainTile } from './heightField';

const manifest: TerrainTileManifest = {
  tileSize: 1,
  maxLevel: 2,
  urlTemplate: '/terrain/{face}/{level}/{x}/{y}.png',
  codec: DEFAULT_TERRAIN_RGB_CODEC,
};

function tile(address: TerrainNodeAddress, value: number, codec = DEFAULT_TERRAIN_RGB_CODEC): TerrainTile {
  return { address, width: 1, height: 1, codec, data: new Float32Array([value]), byteLength: 4 };
}

function response(): TerrainFetchResponse {
  return { ok: true, status: 200, blob: async () => new Blob() };
}

function source(
  byteBudget: number,
  onFetch: (url: string) => Promise<TerrainFetchResponse> = async () => response(),
): { source: TerrainTileSource; calls: string[] } {
  const calls: string[] = [];
  const result = new TerrainTileSource(manifest, {
    byteBudget,
    fetcher: async (url) => {
      calls.push(url);
      return onFetch(url);
    },
    decoder: async (_blob, address, codec) => tile(address, address.x + address.y * 10, codec),
  });
  return { source: result, calls };
}

describe('terrain tile source', () => {
  it('deduplicates concurrent requests and caches the decoded tile', async () => {
    const { source: tiles, calls } = source(64);
    const address: TerrainNodeAddress = { face: 0, level: 1, x: 1, y: 0 };
    const first = tiles.request(address);
    const second = tiles.request(address);
    expect(await first).toEqual(await second);
    expect(calls).toEqual(['/terrain/0/1/1/0.png']);
    expect(tiles.isResident(address)).toBe(true);
    expect((await first).codec).toEqual(manifest.codec);
  });

  it('evicts the least recently used tiles under the byte budget', async () => {
    const { source: tiles } = source(8);
    const first: TerrainNodeAddress = { face: 0, level: 1, x: 0, y: 0 };
    const second: TerrainNodeAddress = { face: 0, level: 1, x: 1, y: 0 };
    const third: TerrainNodeAddress = { face: 0, level: 1, x: 0, y: 1 };
    await tiles.request(first);
    await tiles.request(second);
    expect(tiles.get(first)).toBeDefined();
    await tiles.request(third);
    expect(tiles.isResident(first)).toBe(true);
    expect(tiles.isResident(second)).toBe(false);
    expect(tiles.isResident(third)).toBe(true);
    expect(tiles.residentByteLength).toBe(8);
  });

  it('gates quadtree splitting until all four child tiles are resident', async () => {
    const { source: tiles } = source(16);
    const root: TerrainNodeAddress = { face: 0, level: 0, x: 0, y: 0 };
    expect(tiles.isSplitReady(root)).toBe(false);
    await tiles.requestChildren(root);
    expect(tiles.isSplitReady(root)).toBe(true);
  });

  it('drops an evicted in-flight response instead of re-inserting stale data', async () => {
    let resolveFetch!: (value: TerrainFetchResponse) => void;
    const deferred = new Promise<TerrainFetchResponse>((resolve) => { resolveFetch = resolve; });
    const { source: tiles } = source(64, async () => deferred);
    const address: TerrainNodeAddress = { face: 1, level: 1, x: 0, y: 0 };
    const pending = tiles.request(address);
    expect(tiles.isPending(address)).toBe(true);
    tiles.evict(address);
    resolveFetch(response());
    await expect(pending).rejects.toBeInstanceOf(StaleTerrainTileRequestError);
    expect(tiles.isResident(address)).toBe(false);
    expect(tiles.isPending(address)).toBe(false);
  });

  it('clears residency without allowing old responses to repopulate the cache', async () => {
    let resolveFetch!: (value: TerrainFetchResponse) => void;
    const deferred = new Promise<TerrainFetchResponse>((resolve) => { resolveFetch = resolve; });
    const { source: tiles } = source(64, async () => deferred);
    const address: TerrainNodeAddress = { face: 2, level: 1, x: 0, y: 0 };
    const pending = tiles.request(address);
    tiles.clear();
    resolveFetch(response());
    await expect(pending).rejects.toBeInstanceOf(StaleTerrainTileRequestError);
    expect(tiles.residentCount).toBe(0);
    expect(nodeAddressKey(address)).toBe('2/1/0/0');
  });
});

import {
  childAddress,
  nodeAddressKey,
  validateNodeAddress,
  type TerrainNodeAddress,
} from './quadtree';
import {
  DEFAULT_TERRAIN_RGB_CODEC,
  terrainTileFromRgb,
  validateTerrainRgbCodec,
  type TerrainRgbCodec,
  type ResidentTileSet,
  type TerrainTile,
} from './heightField';

export interface TerrainTileManifest {
  readonly tileSize: number;
  readonly maxLevel: number;
  readonly urlTemplate: string;
  readonly codec: TerrainRgbCodec;
}

export interface TerrainFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  blob(): Promise<Blob>;
}

export type TerrainFetcher = (url: string) => Promise<TerrainFetchResponse>;
export type TerrainDecoder = (blob: Blob, address: TerrainNodeAddress, codec: TerrainRgbCodec) => Promise<TerrainTile>;

export interface TerrainTileSourceOptions {
  readonly byteBudget: number;
  readonly fetcher?: TerrainFetcher;
  readonly decoder?: TerrainDecoder;
}

export class StaleTerrainTileRequestError extends Error {
  constructor(address: TerrainNodeAddress) {
    super(`Terrain tile request became stale before completion: ${nodeAddressKey(address)}`);
    this.name = 'StaleTerrainTileRequestError';
  }
}

interface CacheEntry {
  readonly tile: TerrainTile;
  readonly bytes: number;
  lastUsed: number;
}

interface PendingRequest {
  readonly epoch: number;
  readonly generation: number;
  readonly promise: Promise<TerrainTile>;
}

function defaultFetcher(url: string): Promise<TerrainFetchResponse> {
  if (typeof globalThis.fetch !== 'function') throw new Error('No fetch implementation is available for terrain tiles');
  (globalThis as { __tileDiag?: { fetches: number } }).__tileDiag!.fetches += 1;
  return globalThis.fetch(url);
}

function validateManifest(manifest: TerrainTileManifest): void {
  if (!Number.isSafeInteger(manifest.tileSize) || manifest.tileSize < 1) throw new Error('Terrain manifest tileSize must be positive');
  if (!Number.isSafeInteger(manifest.maxLevel) || manifest.maxLevel < 0) throw new Error('Terrain manifest maxLevel must be non-negative');
  if (!manifest.urlTemplate.includes('{face}')
    || !manifest.urlTemplate.includes('{level}')
    || !manifest.urlTemplate.includes('{x}')
    || !manifest.urlTemplate.includes('{y}')) {
    throw new Error('Terrain manifest urlTemplate must include face, level, x, and y placeholders');
  }
  validateTerrainRgbCodec(manifest.codec);
}

export function terrainTileUrl(manifest: TerrainTileManifest, address: TerrainNodeAddress): string {
  validateManifest(manifest);
  validateNodeAddress(address);
  if (address.level > manifest.maxLevel) throw new Error(`Terrain node level ${address.level} exceeds manifest max ${manifest.maxLevel}`);
  return manifest.urlTemplate
    .replaceAll('{face}', String(address.face))
    .replaceAll('{level}', String(address.level))
    .replaceAll('{x}', String(address.x))
    .replaceAll('{y}', String(address.y));
}

/** Browser decoder seam: fetch supplies a Blob, and this is the only canvas API boundary. */
export async function decodeTerrainRgbBlob(
  blob: Blob,
  address: TerrainNodeAddress,
  codec: TerrainRgbCodec = DEFAULT_TERRAIN_RGB_CODEC,
): Promise<TerrainTile> {
  let bitmap: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof globalThis.createImageBitmap === 'function') {
    bitmap = await globalThis.createImageBitmap(blob);
    canvas = typeof globalThis.OffscreenCanvas === 'function'
      ? new globalThis.OffscreenCanvas(bitmap.width, bitmap.height)
      : document.createElement('canvas');
    if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Unable to create a 2D canvas context for terrain decoding');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    return terrainTileFromRgb(address, width, height, new Uint8Array(image.data), codec);
  }

  if (typeof document === 'undefined') throw new Error('Terrain canvas decoding requires createImageBitmap or a browser document');
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = document.createElement('img');
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Unable to decode terrain tile image'));
      element.src = url;
    });
    canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Unable to create a 2D canvas context for terrain decoding');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height);
    return terrainTileFromRgb(address, image.width, image.height, new Uint8Array(data.data), codec);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Wedge-hunt counters, readable via (globalThis as any).__tileDiag
const tileDiag = { fetches: 0, decodes: 0, evictions: 0, failures: 0 };
(globalThis as { __tileDiag?: typeof tileDiag }).__tileDiag = tileDiag;

export class TerrainTileSource implements ResidentTileSet {
  readonly manifest: TerrainTileManifest;
  readonly byteBudget: number;
  private readonly fetcher: TerrainFetcher;
  private readonly decoder: TerrainDecoder;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly generations = new Map<string, number>();
  private epoch = 0;
  private clock = 0;
  private bytes = 0;

  constructor(manifest: TerrainTileManifest, options: TerrainTileSourceOptions) {
    validateManifest(manifest);
    if (!Number.isFinite(options.byteBudget) || options.byteBudget <= 0) throw new Error('Terrain tile byteBudget must be positive');
    this.manifest = manifest;
    this.byteBudget = options.byteBudget;
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.decoder = options.decoder ?? decodeTerrainRgbBlob;
  }

  get(address: TerrainNodeAddress): TerrainTile | undefined {
    const key = nodeAddressKey(address);
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    entry.lastUsed = ++this.clock;
    return entry.tile;
  }

  isResident(address: TerrainNodeAddress): boolean {
    return this.cache.has(nodeAddressKey(address));
  }

  isPending(address: TerrainNodeAddress): boolean {
    return this.pending.has(nodeAddressKey(address));
  }

  get residentByteLength(): number {
    return this.bytes;
  }

  get residentCount(): number {
    return this.cache.size;
  }

  request(address: TerrainNodeAddress): Promise<TerrainTile> {
    validateNodeAddress(address);
    if (address.level > this.manifest.maxLevel) return Promise.reject(new Error(`Terrain node level ${address.level} exceeds manifest max ${this.manifest.maxLevel}`));
    const key = nodeAddressKey(address);
    const resident = this.get(address);
    if (resident !== undefined) return Promise.resolve(resident);
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing.promise;

    const epoch = this.epoch;
    const generation = this.generations.get(key) ?? 0;
    const promise = this.fetcher(terrainTileUrl(this.manifest, address))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Terrain tile request failed with HTTP ${response.status}`);
        const tile = await this.decoder(await response.blob(), address, this.manifest.codec);
        if (epoch !== this.epoch || generation !== (this.generations.get(key) ?? 0)) {
          throw new StaleTerrainTileRequestError(address);
        }
        if (nodeAddressKey(tile.address) !== key) throw new Error('Terrain decoder returned a tile for the wrong address');
        if (tile.codec.offsetM !== this.manifest.codec.offsetM || tile.codec.scaleM !== this.manifest.codec.scaleM) {
          throw new Error('Terrain decoder returned a tile with a codec different from the manifest');
        }
        this.insert(tile);
        return tile;
      })
      .finally(() => {
        if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
      });
    this.pending.set(key, { epoch, generation, promise });
    return promise;
  }

  isSplitReady(address: TerrainNodeAddress): boolean {
    if (address.level >= this.manifest.maxLevel) return false;
    const children = [
      childAddress(address, 0, 0),
      childAddress(address, 1, 0),
      childAddress(address, 0, 1),
      childAddress(address, 1, 1),
    ];
    return children.every((child) => this.isResident(child));
  }

  requestChildren(address: TerrainNodeAddress): Promise<readonly TerrainTile[]> {
    if (address.level >= this.manifest.maxLevel) return Promise.reject(new Error('A maximum-level node has no children to request'));
    return Promise.all([
      this.request(childAddress(address, 0, 0)),
      this.request(childAddress(address, 1, 0)),
      this.request(childAddress(address, 0, 1)),
      this.request(childAddress(address, 1, 1)),
    ]);
  }

  evict(address: TerrainNodeAddress): void {
    const key = nodeAddressKey(address);
    const entry = this.cache.get(key);
    if (entry !== undefined) {
      this.bytes -= entry.bytes;
      this.cache.delete(key);
    }
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.pending.delete(key);
  }

  clear(): void {
    this.epoch += 1;
    this.cache.clear();
    this.pending.clear();
    this.bytes = 0;
  }

  private insert(tile: TerrainTile): void {
    const key = nodeAddressKey(tile.address);
    const bytes = tile.byteLength ?? tile.data.byteLength;
    const previous = this.cache.get(key);
    if (previous !== undefined) this.bytes -= previous.bytes;
    this.cache.set(key, { tile, bytes, lastUsed: ++this.clock });
    this.bytes += bytes;
    while (this.bytes > this.byteBudget && this.cache.size > 0) {
      tileDiag.evictions += 1;
      let oldestKey: string | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [candidateKey, candidate] of this.cache) {
        if (candidate.lastUsed < oldestUse) {
          oldestUse = candidate.lastUsed;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey === undefined) break;
      const oldest = this.cache.get(oldestKey)!;
      this.bytes -= oldest.bytes;
      this.cache.delete(oldestKey);
    }
  }
}

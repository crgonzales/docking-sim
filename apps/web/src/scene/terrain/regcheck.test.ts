import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { height, terrainTileFromRgb, residentTileMap, type TerrainTile } from './heightField';
import { addressFromDirection, nodeAddressKey } from './quadtree';
import { directionFromLatLon } from './heightField';

const TERRAIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/assets/terrain');

function loadManifest() {
  return JSON.parse(readFileSync(resolve(TERRAIN_DIR, 'manifest.json'), 'utf8'));
}

function loadTileFor(latRad: number, lonRad: number, level: number, manifest: ReturnType<typeof loadManifest>) {
  const direction = directionFromLatLon(latRad, lonRad);
  const address = addressFromDirection(direction, level);
  const path = resolve(TERRAIN_DIR, 'base', String(address.face), String(address.level), String(address.x), `${address.y}.png`);
  const png = PNG.sync.read(readFileSync(path));
  return terrainTileFromRgb(address, png.width, png.height, new Uint8Array(png.data), manifest.codec);
}

describe('baked-tile geographic registration', () => {
  it('finds Everest and the Mariana trench through directionFromLatLon', () => {
    const manifest = loadManifest();
    const level = manifest.maxLevel ?? 3;
    const everestLat = 27.988 * Math.PI / 180;
    const everestLon = 86.925 * Math.PI / 180;
    const marianaLat = 11.37 * Math.PI / 180;
    const marianaLon = 142.59 * Math.PI / 180;
    const tiles = new Map<string, TerrainTile>();
    for (const [lat, lon] of [[everestLat, everestLon], [marianaLat, marianaLon]] as const) {
      const tile = loadTileFor(lat, lon, level, manifest);
      tiles.set(nodeAddressKey(tile.address), tile);
    }
    const resident = residentTileMap(tiles);
    const everest = height(everestLat, everestLon, { tiles: resident, level, heroRegions: [] } as never);
    const mariana = height(marianaLat, marianaLon, { tiles: resident, level, heroRegions: [] } as never);
    // Ground-truth registration oracle: these two points proved a +180-deg
    // longitude bug in directionFromLatLon during v0.9.0 — keep them honest.
    expect(everest).not.toBeNull();
    expect(everest!).toBeGreaterThan(6_000);
    expect(mariana).not.toBeNull();
    expect(mariana!).toBeLessThan(-9_000);
  });
});

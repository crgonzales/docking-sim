import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { CharacterSession } from './characterSession';
import { createGroundSampler, sampleGroundHeight, sampleStableGround } from './characterGround';
import { TerrainTileSource, type TerrainTileManifest } from '../scene/terrain/tileSource';
import { directionFromLatLon, terrainTileFromRgb } from '../scene/terrain/heightField';
import { addressFromDirection } from '../scene/terrain/quadtree';
import { EARTH_RADIUS_M } from '../scene/sky/skyConfig';

const { PNG } = createRequire(import.meta.url)('pngjs');

it('initializes, walks and completes boarding/exit against actual committed terrain tiles', async () => {
  const manifest: TerrainTileManifest = JSON.parse(readFileSync(new URL('../../public/assets/terrain/manifest.json', import.meta.url), 'utf8'));
  const source = new TerrainTileSource(manifest, {
    byteBudget: 8 * 1024 * 1024,
    fetcher: async (url) => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array(readFileSync(new URL(`../../public${url}`, import.meta.url)))]) }),
    decoder: async (blob, address, codec) => {
      const png = PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
      return terrainTileFromRgb(address, png.width, png.height, new Uint8Array(png.data), codec);
    },
  });
  const ref: { current: TerrainTileSource | null } = { current: null }, sampler = createGroundSampler(ref);
  const s = new CharacterSession({ start: 'GROUND', groundSampler: sampler });
  expect(s.groundReady).toBe(false); ref.current = source;
  const origin = s.position_N_m;
  for (let level = 0; level <= manifest.maxLevel; level++) {
    // Include the 1 km slope-mask footprint surrounding the fixture.
    for (const north of [-1100, 0, 1100]) for (const east of [-1100, 0, 1100]) {
      await source.request(addressFromDirection(directionFromLatLon((origin[0] + north) / EARTH_RADIUS_M, (origin[1] + east) / EARTH_RADIUS_M), level));
    }
    s.advance(0);
    expect(s.groundReady).toBe(true);
    expect(s.position_N_m[2]).toBeLessThan(0);
  }
  expect(s.interact().kind, JSON.stringify({ reason: s.interaction, feet: s.position_N_m, plane: s.flight.state.position_N_m })).toBe('BOARDED');
  expect(s.interact().kind).toBe('EXITED');
  const before = s.position_N_m;
  s.key('KeyW', true); for (let i = 0; i < 30; i++) s.advance(1 / 30); s.key('KeyW', false);
  expect(s.position_N_m[0] - before[0]).toBeCloseTo(3, 7);
  expect(s.position_N_m[2]).toBe(-sampler(s.position_N_m)!);
  expect(s.interact().kind, JSON.stringify({ reason: s.interaction, feet: s.position_N_m, plane: s.flight.state.position_N_m })).toBe('BOARDED');
  ref.current = null;
  expect(sampler(s.position_N_m)).toBeNull();
  expect(sampleGroundHeight([NaN, 0, 0], source)).toBeNull();
  expect(sampleGroundHeight([2 * EARTH_RADIUS_M, 0, 0], source)).toBeNull();
});

it('requires finite, resident land around both standing points', () => {
  expect(sampleStableGround(() => 100, [0, 0, -100])).toBe(100);
  expect(sampleStableGround((p) => p[0] > 0 ? null : 100, [0, 0, -100])).toBeNull();
  expect(sampleStableGround((p) => p[1] > 0 ? -10 : 100, [0, 0, -100])).toBeNull();
  expect(sampleStableGround((p) => p[0] > 0 ? 110 : 100, [0, 0, -100])).toBeNull();
});

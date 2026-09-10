import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Texture, Vector3 } from 'three';
import { createTerrainPatchGeometry } from './TerrainPatches';
import { buildPatchGeometry, patchWaterMask, type PatchBuildResult } from './terrainWorker';
import { buildWaterPatchGeometry } from './terrainWater';
import { DEFAULT_TERRAIN_RGB_CODEC, directionFromLatLon, terrainTileFromRgb, type TerrainTile } from './heightField';
import { addressFromDirection } from './quadtree';
import { SKY_DERIVED } from '../sky/skyConfig';
import { createTerrainPatchMaterial, createWaterMaterial, TERRAIN_FRAGMENT_SHADER, TERRAIN_VERTEX_SHADER } from './terrainShaders';

const rendererMode = vi.hoisted(() => ({ library: false }));
vi.mock('../renderProbeConfig', () => ({ get LIBRARY_RENDERER() { return rendererMode.library; }, PROBE_PROFILE: false }));

const disposables: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T { disposables.push(value); return value; }
afterEach(() => { disposables.splice(0).forEach(value => value.dispose()); rendererMode.library = false; });
const radius = SKY_DERIVED.earthRadiusM;

function patch(heightM: number, level = 10, shore = false): PatchBuildResult {
  const address = { face: 0 as const, level, x: Math.floor(2 ** level / 2), y: Math.floor(2 ** level / 2) };
  const tiles: TerrainTile[] = ([0, 1, 2, 3, 4, 5] as const).map(face => ({
    address: { face, level: 0, x: 0, y: 0 }, width: 2, height: 2,
    codec: DEFAULT_TERRAIN_RGB_CODEC, data: new Float32Array(4).fill(heightM),
  }));
  if (shore) tiles.push({ address, width: 2, height: 2, codec: DEFAULT_TERRAIN_RGB_CODEC,
    data: new Float32Array([-1000, 600, -1000, 600]) });
  return buildPatchGeometry({ type: 'buildPatch', address, tiles, codec: DEFAULT_TERRAIN_RGB_CODEC,
    detail: { baseAmplitudeM: 0 }, skirtDepthM: 2 });
}

function surface(result: PatchBuildResult, library = true) {
  return own(createTerrainPatchGeometry(result, buildWaterPatchGeometry(result, radius), library));
}

// Execute the material selection from the real fragment shader; no duplicated
// CPU threshold. GLSL vec4's two constructor forms are sufficient for this seam.
function shade(mask: number): number[] {
  const expression = TERRAIN_FRAGMENT_SHADER.match(/gl_FragColor = (vTerrainWaterMask[^;]+);/)?.[1];
  expect(expression).toBeDefined();
  const vec4 = (...values: (number | number[])[]) => values.flat();
  return Function('vTerrainWaterMask', 'albedo', 'vec4', `return ${expression};`)(mask, [0.2, 0.3, 0.4], vec4);
}

describe('one opaque library terrain surface', () => {
  it.each([0, 3, 10])('removes the equal-depth material ambiguity without shifting sea-level vertices at LOD %i', level => {
    const result = patch(0, level), geometry = surface(result);
    const baseBytes = result.baseVertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
    // This is the old conflict: two differently shaded draws at identical positions.
    expect(new Uint8Array(result.positions, 0, baseBytes)).toEqual(new Uint8Array(result.waterPositions, 0, baseBytes));
    expect(geometry.getAttribute('position').array).toEqual(new Float32Array(result.positions));
    expect(geometry.getAttribute('terrainWaterMask').array.every(value => value === 1)).toBe(true);
    expect(shade(1)).toEqual([0.015, 0.04, 0.07, 0.5]);
    // The owner must not install its separate water overlay in this mode.
    const owner = readFileSync(new URL('./TerrainPatches.tsx', import.meta.url), 'utf8');
    expect(owner).toContain('if (waterData.hasWater && !LIBRARY_RENDERER)');
  });

  it.each([0.001, -1000])('keeps a closed surface and skirt bottoms for %sm DEM', heightM => {
    const result = patch(heightM), geometry = surface(result);
    const positions = geometry.getAttribute('position').array;
    const original = new Float32Array(result.positions);
    const normals = geometry.getAttribute('normal').array;
    const sourceNormals = new Float32Array(result.normals);
    expect(geometry.index!.array).toEqual(new Uint32Array(result.indices));
    expect(positions.slice(result.baseVertexCount * 3)).toEqual(original.slice(result.baseVertexCount * 3));
    for (let i = 0; i < result.vertexCount; i++) {
      const local = new Vector3().fromArray(positions, i * 3);
      const absolute = local.clone().add(new Vector3(...result.patchCenterF64));
      expect(local.length()).toBeLessThanOrEqual(geometry.boundingSphere!.radius + 1e-6);
      if (heightM > 0) {
        expect(positions.slice(i * 3, i * 3 + 3)).toEqual(original.slice(i * 3, i * 3 + 3));
        expect(normals.slice(i * 3, i * 3 + 3)).toEqual(sourceNormals.slice(i * 3, i * 3 + 3));
        expect(geometry.getAttribute('terrainWaterMask').getX(i)).toBe(0);
      } else if (i < result.baseVertexCount) {
        expect(Math.abs(absolute.length() - radius)).toBeLessThan(0.3);
        expect(new Vector3().fromArray(normals, i * 3).distanceTo(absolute.normalize())).toBeLessThan(1e-6);
      }
      // Below-sea-level skirt positions must not turn positive land into water.
      if (i >= result.baseVertexCount) expect(absolute.length()).toBeLessThan(radius);
    }
  });

  it('joins submerged and dry shore vertices on one continuous indexed surface with intact land normals', () => {
    const result = patch(600, 10, true), geometry = surface(result);
    const semantic = patchWaterMask(result), positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal'), sourceNormals = new Float32Array(result.normals);
    const terrain = new Float32Array(result.positions), water = new Float32Array(result.waterPositions);
    const indices = geometry.index!.array;
    expect(new Set(semantic)).toEqual(new Set([0, 1]));
    let shoreTriangles = 0, oldShoreGap = 0;
    for (let i = 0; i < result.baseVertexCount; i++) {
      if (semantic[i] === 0) {
        expect(normals.array.slice(i * 3, i * 3 + 3)).toEqual(sourceNormals.slice(i * 3, i * 3 + 3));
        expect(positions.array.slice(i * 3, i * 3 + 3)).toEqual(terrain.slice(i * 3, i * 3 + 3));
      }
    }
    for (let i = 0; i < indices.length; i += 3) {
      const triangle = [...indices.slice(i, i + 3)];
      if (triangle.some(index => index >= result.baseVertexCount)) continue;
      const wet = triangle.find(index => semantic[index] === 1), dry = triangle.find(index => semantic[index] === 0);
      if (wet === undefined || dry === undefined) continue;
      shoreTriangles++;
      const interpolate = (data: ArrayLike<number>, t: number) => new Vector3().fromArray(data, dry * 3)
        .lerp(new Vector3().fromArray(data, wet * 3), t);
      // Complementary discards on the old separate geometry would meet at
      // different positions on a mixed edge, leaving a real shoreline tear.
      oldShoreGap = Math.max(oldShoreGap, interpolate(terrain, 0.5).distanceTo(interpolate(water, 0.5)));
      for (const t of [0, 0.49, 0.5, 0.51, 1]) {
        expect(shade(t)[3]).toBe(t < 0.5 ? 1 : 0.5);
        expect(interpolate(positions.array, t).distanceTo(interpolate(water, t))).toBe(0);
        // Stock MeshNormalMaterial normalizes this interpolated slope/radial
        // blend per fragment; interpolation itself need not have unit length.
        const normal = interpolate(normals.array, t);
        expect(normal.length()).toBeGreaterThan(0.5);
        expect(normal.normalize().length()).toBeCloseTo(1, 12);
      }
    }
    expect(shoreTriangles).toBeGreaterThan(0);
    expect(oldShoreGap).toBeGreaterThan(1);
    expect(TERRAIN_VERTEX_SHADER).toContain('vTerrainWaterMask = terrainWaterMask;');
    expect(TERRAIN_FRAGMENT_SHADER).not.toMatch(/\bdiscard\b/);
    // SurfaceNormalPass's water-only adapter must never discard this mesh's land.
    expect(geometry.hasAttribute('waterMask')).toBe(false);
  });

  it('leaves legacy terrain geometry, normals and skirts byte-for-byte unchanged', () => {
    const result = patch(600, 10, true), geometry = surface(result, false);
    expect(geometry.getAttribute('position').array).toEqual(new Float32Array(result.positions));
    expect(geometry.getAttribute('normal').array).toEqual(new Float32Array(result.normals));
    expect(geometry.hasAttribute('terrainWaterMask')).toBe(false);
    expect(geometry.boundingSphere!.radius).toBe(result.boundingSphereRadiusM);
  });

  it('renders the packaged Atlantic bathymetry at the geoid with radial ocean normals', () => {
    const assets = new URL('../../../public/assets/terrain/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', assets), 'utf8'));
    const { PNG } = createRequire(import.meta.url)('pngjs') as {
      PNG: { sync: { read(bytes: Buffer): { width: number; height: number; data: Uint8Array } } };
    };
    const tiles = ([0, 1, 2, 3, 4, 5] as const).map(face => {
      const png = PNG.sync.read(readFileSync(new URL(`base/${face}/0/0/0.png`, assets)));
      return terrainTileFromRgb({ face, level: 0, x: 0, y: 0 }, png.width, png.height, png.data, manifest.codec);
    });
    const address = addressFromDirection(directionFromLatLon(20 * Math.PI / 180, -40 * Math.PI / 180), 10);
    const result = buildPatchGeometry({ type: 'buildPatch', address, tiles, codec: manifest.codec,
      detail: { baseAmplitudeM: 0 }, skirtDepthM: 2 });
    const geometry = surface(result), center = new Vector3(...result.patchCenterF64);
    const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
    const originalPositions = new Float32Array(result.positions);
    expect(patchWaterMask(result).every(value => value === 1)).toBe(true);
    for (let i = 0; i < result.baseVertexCount; i++) {
      const seafloor = new Vector3().fromArray(originalPositions, i * 3).add(center);
      expect(seafloor.length()).toBeLessThan(radius - 1000);
      const point = new Vector3().fromBufferAttribute(positions, i).add(center);
      expect(Math.abs(point.length() - radius)).toBeLessThan(0.3);
      expect(new Vector3().fromBufferAttribute(normals, i).distanceTo(point.normalize())).toBeLessThan(1e-6);
    }
  });

  it.each([false, true])('allows a mode to override the page renderer (library=%s)', library => {
    rendererMode.library = !library;
    const texture = own(new Texture());
    const options = { planetCenter: [0, 0, 0] as const, surfaceRadius: radius,
      atmosphereRadius: radius + 60000, libraryRenderer: library };
    const terrain = own(createTerrainPatchMaterial({ dayMap: texture, specMap: texture,
      cloudMap: texture, transmittanceLut: texture }, options));
    const water = own(createWaterMaterial(options));
    const result = patch(-1000);
    const geometry = surface(result, library);
    expect(terrain.defines.LIBRARY_LIGHTING === 1).toBe(library);
    expect(terrain.defines.TERRAIN_WATER_MAP === 1).toBe(library);
    expect(geometry.hasAttribute('terrainWaterMask')).toBe(library);
    expect(terrain.transparent).toBe(!library);
    expect(water.depthWrite).toBe(library);
  });

  it.each([false, true])('retains the renderer material/depth contract (library=%s)', library => {
    rendererMode.library = library;
    const texture = own(new Texture());
    const options = { planetCenter: [0, 0, 0] as const, surfaceRadius: radius, atmosphereRadius: radius + 60000 };
    const terrain = own(createTerrainPatchMaterial({ dayMap: texture, cloudMap: texture, transmittanceLut: texture }, options));
    const water = own(createWaterMaterial(options));
    expect(terrain.defines).toEqual(library ? { LIBRARY_LIGHTING: 1 } : {});
    expect(terrain.transparent).toBe(!library);
    expect(terrain.depthWrite).toBe(true);
    expect(water.transparent).toBe(!library);
    expect(water.depthWrite).toBe(library);
    expect(terrain.polygonOffset).toBe(false);
    expect(terrain.vertexShader).toMatch(/#ifdef LIBRARY_LIGHTING\s+attribute float terrainWaterMask;/);
  });
});

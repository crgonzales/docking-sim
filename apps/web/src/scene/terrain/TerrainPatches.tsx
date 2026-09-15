import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  Sphere,
  Texture,
  Vector3,
  type ShaderMaterial,
} from 'three';
import {
  EARTH_RADIUS_M,
  SKY_CONFIG,
  SKY_DERIVED,
  TERRAIN_ENGAGEMENT_ALTITUDE_M,
  TERRAIN_MAX_LIVE_PATCHES,
  TERRAIN_MAX_LEVEL,
  TERRAIN_TILE_CACHE_BUDGET_BYTES,
  TERRAIN_WORKER_BUILD_CONCURRENCY,
  terrainFadeFromAltitudeM,
} from '../sky/skyConfig';
import { PROBE_PROFILE } from '../renderProbeConfig';
import { createTerrainSurfaceNoise, createTerrainSurfaceUniforms, type TerrainSurfaceNoiseResource } from './terrainSurface';
import {
  nodeAngularRadiusRadians,
  nodeCenterDirection,
  parentAddress,
  nodeAddressKey,
  type TerrainNodeAddress,
  type Vec3,
} from './quadtree';
import {
  TerrainTileSource,
  decodeTerrainRgbBlob,
  type TerrainTileManifest,
} from './tileSource';
import {
  heroWeight,
  type HeroRegionConfig,
  type TerrainRgbCodec,
} from './heightField';
import {
  createTerrainPatchMaterial,
  type TerrainShaderTextures,
} from './terrainShaders';
import {
  TerrainWorkerPool,
  requiredPatchTileAddresses,
  type PatchBuildResult,
  type PatchBuildRequest,
  type PatchHeroRegionConfig,
  type PatchHeroTile,
} from './terrainWorker';
import {
  isTerrainNodeHorizonVisible,
  mergeCompleteSiblings,
  rootTerrainNodes,
  selectTerrainNodes,
  swapCompleteSiblings,
  terrainResidencyKeys,
  isTerrainCoverageReady,
  indexDesiredTerrain,
} from './terrainNodeSet';
import { buildWaterPatchGeometry, type WaterPatchGeometry } from './terrainWater';
import { renderTimings } from '../renderTimings';
import type { WorldFrame, WorldPositionF64 } from '../worldFrame';

const BASE_MANIFEST_URL = '/assets/terrain/manifest.json';
const HERO_MANIFEST_URL = '/assets/terrain/hero/manifest.json';
/** The hero pyramid's coarsest level: a single tile spans the whole region, which is already far finer than the base raster at the currently configured TERRAIN_MAX_LEVEL. */
const HERO_TILE_LEVEL = 0;

interface HeroManifestRegion {
  readonly urlTemplate: string;
  readonly codec: TerrainRgbCodec;
  readonly region: {
    readonly id: string;
    readonly bounds: {
      readonly minLat: number;
      readonly maxLat: number;
      readonly minLon: number;
      readonly maxLon: number;
    };
  };
}

interface HeroManifest {
  readonly regions: readonly HeroManifestRegion[];
}

async function loadHeroManifest(url: string): Promise<HeroManifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load hero terrain manifest ${url}: HTTP ${response.status}`);
  return response.json() as Promise<HeroManifest>;
}

export interface TerrainPatchesProps {
  /** Parent may retire its opaque globe only once this complete cover is active. */
  readonly onCoverageReadyChange?: (ready: boolean) => void;
  readonly worldFrame: WorldFrame;
  readonly terrainSourceRef: { current: TerrainTileSource | null };
  readonly earthCenterF64: WorldPositionF64;
  readonly dayMap: Texture;
  readonly specMap: Texture;
  readonly radius: number;
}

interface PatchRecord {
  readonly heroInputKey: string;
  readonly result: PatchBuildResult;
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
}

function vectorLength(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function sameNodes(a: readonly TerrainNodeAddress[], b: readonly TerrainNodeAddress[]): boolean {
  return a.length === b.length && a.every((node, i) => {
    const other = b[i]!;
    return node.face === other.face && node.level === other.level && node.x === other.x && node.y === other.y;
  });
}

function childrenOf(address: TerrainNodeAddress): readonly TerrainNodeAddress[] {
  return [
    { face: address.face, level: address.level + 1, x: address.x * 2, y: address.y * 2 },
    { face: address.face, level: address.level + 1, x: address.x * 2 + 1, y: address.y * 2 },
    { face: address.face, level: address.level + 1, x: address.x * 2, y: address.y * 2 + 1 },
    { face: address.face, level: address.level + 1, x: address.x * 2 + 1, y: address.y * 2 + 1 },
  ];
}

/**
 * Cheap overlap test reusing heightField's own hero-weight geometry (rather
 * than duplicating the haversine math): pads the region radius by the
 * patch's own angular size so a patch whose CENTER sits just outside the
 * feathered radius, but whose footprint still dips in, is not missed.
 */
function patchOverlapsHeroRegion(
  address: TerrainNodeAddress,
  region: Pick<HeroRegionConfig, 'id' | 'centerLatDeg' | 'centerLonDeg' | 'radiusKm' | 'featherKm'>,
  planetRadiusKm: number,
): boolean {
  const center = nodeCenterDirection(address);
  const latRad = Math.asin(Math.max(-1, Math.min(1, center[1])));
  const lonRad = Math.atan2(-center[2], center[0]);
  const patchRadiusKm = nodeAngularRadiusRadians(address) * planetRadiusKm;
  const probe: HeroRegionConfig = { ...region, radiusKm: region.radiusKm + patchRadiusKm, sample: () => null };
  return heroWeight(probe, latRad, lonRad) > 0;
}

async function loadManifest(url: string): Promise<TerrainTileManifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load terrain manifest ${url}: HTTP ${response.status}`);
  return response.json() as Promise<TerrainTileManifest>;
}

export function createTerrainPatchGeometry(
  result: PatchBuildResult,
  water: WaterPatchGeometry,
): BufferGeometry {
  const geometry = new BufferGeometry();
  // Share one continuous surface at mixed/negative-height shores. Keep the
  // original skirt bottoms: water's collapsed skirts cannot close LOD cracks.
  const positions = new Float32Array(water.positions.slice(0));
  positions.set(new Float32Array(result.positions).subarray(result.baseVertexCount * 3), result.baseVertexCount * 3);
  // Distinct from waterMask: the normal pass must retain the entire surface,
  // including dry land, rather than apply its water-only coverage discard.
  geometry.setAttribute('terrainWaterMask', new BufferAttribute(new Float32Array(water.waterMask), 1));
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(water.normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(result.uvs), 2));
  geometry.setIndex(new BufferAttribute(new Uint32Array(result.indices), 1));
  // Worker positions are relative to the patch centre, so the local sphere
  // is centred at zero and remains valid while RTC placement changes.
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0),
    Math.max(result.boundingSphereRadiusM, water.boundingSphereRadiusM));
  return geometry;
}

/**
 * The live terrain owner. It deliberately performs no manifest/tile/worker
 * work until the camera enters the configured crossfade band.
 */
export function TerrainPatches({
  onCoverageReadyChange,
  worldFrame,
  terrainSourceRef,
  earthCenterF64,
  dayMap,
  specMap,
  radius,
}: TerrainPatchesProps) {
  const { camera, size } = useThree();
  const coverageReadyRef = useRef(false);
  const coverageCallbackRef = useRef(onCoverageReadyChange);
  coverageCallbackRef.current = onCoverageReadyChange;
  const setCoverageReady = (ready: boolean): void => {
    if (coverageReadyRef.current === ready) return;
    coverageReadyRef.current = ready;
    coverageCallbackRef.current?.(ready);
  };
  const groupRef = useRef<Group>(null);
  const sourceRef = useRef<TerrainTileSource | null>(null);
  const poolRef = useRef<TerrainWorkerPool | null>(null);
  const initializationRef = useRef<Promise<void> | null>(null);
  const epochRef = useRef(0);
  const rootRequestRef = useRef<Promise<void> | null>(null);
  const buildRequestsRef = useRef(new Map<string, symbol>());
  const desiredResidencyRef = useRef(terrainResidencyKeys(rootTerrainNodes()));
  const dirtyHeroRef = useRef(new Set<string>());
  const surfaceNoiseRef = useRef<TerrainSurfaceNoiseResource | null>(null);
  // Hero DEM tiles are a small, address-independent asset cache: unlike
  // sourceRef's per-address tile cache, nothing here needs clearing when
  // terrain fades out and re-engages later.
  const heroManifestRef = useRef<HeroManifest | null>(null);
  const heroManifestRequestRef = useRef<Promise<void> | null>(null);
  const heroTileCacheRef = useRef(new Map<string, PatchHeroTile>());
  const heroTileRequestsRef = useRef(new Set<string>());
  const heroTileFailedRef = useRef(new Set<string>());
  const recordsRef = useRef(new Map<string, PatchRecord>());
  const displayedRef = useRef<readonly TerrainNodeAddress[]>([]);
  const desiredRef = useRef<readonly TerrainNodeAddress[]>([]);
  const desiredIndexRef = useRef(indexDesiredTerrain([]));
  const selectionInputsRef = useRef<readonly number[]>([]);
  const reconciliationDirtyRef = useRef(true);

  const disposeRecord = (key: string): void => {
    diagRef.current.disposed += 1;
    const record = recordsRef.current.get(key);
    if (record === undefined) return;
    groupRef.current?.remove(record.mesh);
    record.mesh.geometry.dispose();
    record.mesh.material.dispose();
    recordsRef.current.delete(key);
    reconciliationDirtyRef.current = true;
    dirtyHeroRef.current.delete(key);
  };

  const disposeAll = (): void => {
    for (const key of recordsRef.current.keys()) disposeRecord(key);
    displayedRef.current = [];
    buildRequestsRef.current.clear();
    dirtyHeroRef.current.clear();
  };

  const readyKeys = (): ReadonlySet<string> => new Set(recordsRef.current.keys());

  // Opt-in churn diagnostics (?terraindiag=1): counters that name a wedge —
  // this instrumentation identified the v0.9.0 request-storm OOM and stays
  // available because scene-loop churn bugs are invisible in screenshots.
  const diagRef = useRef({ built: 0, requested: 0, disposed: 0, lastLog: 0 });
  const diagEnabled = useMemo(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('terraindiag') === '1',
    [],
  );
  const diagTick = (): void => {
    if (!diagEnabled) return;
    const now = performance.now();
    if (now - diagRef.current.lastLog < 2000) return;
    diagRef.current.lastLog = now;
    // eslint-disable-next-line no-console
    console.log('[terrain-diag]', JSON.stringify({
      ...diagRef.current,
      records: recordsRef.current.size,
      displayed: displayedRef.current.length,
      desired: desiredRef.current.length,
      buildsInFlight: buildRequestsRef.current.size,
      residentAndReserved: new Set([...recordsRef.current.keys(), ...buildRequestsRef.current.keys()]).size,
      coverageReady: coverageReadyRef.current,
    }));
  };

  const reconcileDisplayed = (): void => {
    if (!reconciliationDirtyRef.current) return;
    reconciliationDirtyRef.current = false;
    const startedAt = renderTimings.start('terrain.reconciliation');
    const desired = desiredRef.current;
    const ready = readyKeys();
    try {
      let next = mergeCompleteSiblings(displayedRef.current, desired, ready, desiredIndexRef.current);
      next = swapCompleteSiblings(next, desired, ready, desiredIndexRef.current);
      const roots = rootTerrainNodes();
      if (next.length === 0 && roots.every((root) => ready.has(nodeAddressKey(root)))) next = roots;
      // Keep advancing on subsequent frames when a jump requires several
      // coarsening/splitting levels, even if no new worker result arrives.
      if (!sameNodes(next, displayedRef.current)) reconciliationDirtyRef.current = true;
      displayedRef.current = next;
      retireUnused();
    } finally {
      renderTimings.end('terrain.reconciliation', startedAt);
    }
  };

  const retireUnused = (): void => {
    // Current fallback ancestors must survive until coarsening completes.
    // Future siblings are protected by the desired tree's complete closure.
    const protectedKeys = terrainResidencyKeys(displayedRef.current);
    for (const key of desiredResidencyRef.current) protectedKeys.add(key);
    for (const key of recordsRef.current.keys()) {
      if (!protectedKeys.has(key)) disposeRecord(key);
    }
  };

  const createPatch = (result: PatchBuildResult, epoch: number, heroInputKey: string): void => {
    if (epoch !== epochRef.current) return;
    const key = nodeAddressKey(result.address);
    if (!desiredResidencyRef.current.has(key)) return;
    // A hero tile can arrive while this worker is busy. Never install its
    // superseded result; retain the old mesh until a replacement is ready.
    if (heroInputKey !== gatherHeroTiles(result.address).map((tile) => tile.regionId).join('|')) return;
    if (!recordsRef.current.has(key) && recordsRef.current.size >= TERRAIN_MAX_LIVE_PATCHES) return;
    diagRef.current.built += 1;
    const geometryStartedAt = renderTimings.start('terrain.geometryPreparation');
    let geometry: BufferGeometry;
    let waterData: WaterPatchGeometry;
    try {
      waterData = buildWaterPatchGeometry(result, radius);
      geometry = createTerrainPatchGeometry(result, waterData);
    } finally {
      renderTimings.end('terrain.geometryPreparation', geometryStartedAt);
    }
    const material = createTerrainPatchMaterial(
      { dayMap, specMap } satisfies TerrainShaderTextures,
      { planetCenter: worldFrame.toRender(earthCenterF64) },
    );
    const mesh = new Mesh(geometry, material);
    surfaceNoiseRef.current ??= createTerrainSurfaceNoise();
    Object.assign(material.uniforms, createTerrainSurfaceUniforms(surfaceNoiseRef.current, radius, {
      enabled: new URLSearchParams(location.search).get('terrainDetail') !== 'off',
      patchCenterM: result.patchCenterF64,
    }));
    material.uniforms.terrainSurfaceMetersPerUnit = { value: SKY_CONFIG.renderScaleMPerUnit };
    material.defines.TERRAIN_SURFACE_DETAIL = 1;
    mesh.frustumCulled = true;
    mesh.renderOrder = 0.5;
    groupRef.current?.add(mesh);
    if (recordsRef.current.has(key)) disposeRecord(key);
    recordsRef.current.set(key, { result, mesh, heroInputKey });
    reconciliationDirtyRef.current = true;
  };

  const gatherTiles = (address: TerrainNodeAddress): readonly PatchBuildRequest['tiles'][number][] | null => {
    const source = sourceRef.current;
    if (source === null) return null;
    const required = new Map<string, TerrainNodeAddress>();
    for (const start of requiredPatchTileAddresses(address, source.manifest.maxLevel)) {
      let current: TerrainNodeAddress | null = start;
      while (current !== null) {
        const key = nodeAddressKey(current);
        if (required.has(key)) break;
        required.set(key, current);
        current = parentAddress(current);
      }
    }
    // Include ancestor inputs in readiness too: reserved no-data pixels must
    // not acquire a different fallback just because an evicted ancestor is
    // fetched after this mesh has already been built.
    let ready = true;
    for (const tileAddress of required.values()) {
      if (source.isResident(tileAddress)) continue;
      ready = false;
      if (!source.isPending(tileAddress)) {
        diagRef.current.requested += 1;
        void source.request(tileAddress).catch(() => undefined);
      }
    }
    if (!ready) return null;
    const tiles = new Map<string, PatchBuildRequest['tiles'][number]>();
    for (const [key, tileAddress] of required) tiles.set(key, source.get(tileAddress)!);
    return [...tiles.values()];
  };

  // Best-effort, fire-once: a failed fetch just leaves hero blending absent
  // (today's status quo), it must never block base terrain from building.
  const requestHeroTile = (region: PatchHeroRegionConfig): void => {
    if (heroTileCacheRef.current.has(region.id)
      || heroTileRequestsRef.current.has(region.id)
      || heroTileFailedRef.current.has(region.id)) return;
    const manifest = heroManifestRef.current;
    if (manifest === null) return;
    const manifestRegion = manifest.regions.find((entry) => entry.region.id === region.id);
    if (manifestRegion === undefined) return;
    heroTileRequestsRef.current.add(region.id);
    const url = manifestRegion.urlTemplate
      .replaceAll('{level}', String(HERO_TILE_LEVEL))
      .replaceAll('{x}', '0')
      .replaceAll('{y}', '0');
    void fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load hero tile ${url}: HTTP ${response.status}`);
        const decoded = await decodeTerrainRgbBlob(
          await response.blob(),
          { face: 0, level: HERO_TILE_LEVEL, x: 0, y: 0 },
          manifestRegion.codec,
        );
        const bounds = manifestRegion.region.bounds;
        heroTileCacheRef.current.set(region.id, {
          regionId: region.id,
          tileSize: decoded.width,
          bounds: {
            minLatDeg: bounds.minLat,
            maxLatDeg: bounds.maxLat,
            minLonDeg: bounds.minLon,
            maxLonDeg: bounds.maxLon,
          },
          data: decoded.data,
        });
        for (const [key, record] of recordsRef.current) {
          if (patchOverlapsHeroRegion(record.result.address, region, SKY_CONFIG.earthRadiusKm)) dirtyHeroRef.current.add(key);
        }
      })
      // Permanent, like the manifest fallback above: a hero tile that fails
      // once would otherwise be re-fetched on every future ensurePatch call
      // for a patch near that region, forever.
      .catch(() => { heroTileFailedRef.current.add(region.id); })
      .finally(() => heroTileRequestsRef.current.delete(region.id));
  };

  // Only requests/attaches a region's tile when this patch's footprint
  // actually overlaps it — otherwise every patch worldwide would bundle
  // every hero region's raster through structured clone, the same
  // per-request payload waste Bug 1 fixed for the 6 cube-face roots.
  const gatherHeroTiles = (address: TerrainNodeAddress): readonly PatchHeroTile[] => {
    const tiles: PatchHeroTile[] = [];
    for (const region of SKY_CONFIG.terrain.heroRegions) {
      if (!patchOverlapsHeroRegion(address, region, SKY_CONFIG.earthRadiusKm)) continue;
      const cached = heroTileCacheRef.current.get(region.id);
      if (cached !== undefined) tiles.push(cached);
      else requestHeroTile(region);
    }
    return tiles;
  };

  const ensurePatch = (address: TerrainNodeAddress, epoch: number): void => {
    if (epoch !== epochRef.current) return;
    const key = nodeAddressKey(address);
    if (!desiredResidencyRef.current.has(key) || buildRequestsRef.current.has(key)) return;
    const existing = recordsRef.current.get(key);
    if (existing !== undefined && !dirtyHeroRef.current.has(key)) return;
    const source = sourceRef.current;
    const pool = poolRef.current;
    if (source === null || pool === null) return;
    // Reserve capacity before gathering payloads or queueing work. Replacing
    // an existing mesh uses its current slot; old/new camera trees share the
    // same hard budget while parent fallbacks allow obsolete branches to merge.
    let occupied = recordsRef.current.size;
    for (const pendingKey of buildRequestsRef.current.keys()) if (!recordsRef.current.has(pendingKey)) occupied += 1;
    if (existing === undefined && occupied >= TERRAIN_MAX_LIVE_PATCHES) return;
    const tiles = gatherTiles(address);
    if (tiles === null) return;
    const heroTiles = gatherHeroTiles(address);
    const heroInputKey = heroTiles.map((tile) => tile.regionId).join('|');
    if (existing?.heroInputKey === heroInputKey) {
      dirtyHeroRef.current.delete(key);
      return;
    }
    const token = Symbol(key);
    buildRequestsRef.current.set(key, token);
    const request: Omit<PatchBuildRequest, 'requestId'> = {
      type: 'buildPatch', address, tiles, codec: source.manifest.codec,
      heroRegions: SKY_CONFIG.terrain.heroRegions.map((region): PatchHeroRegionConfig => ({ ...region })),
      heroTiles, planetRadiusM: EARTH_RADIUS_M,
      ...(PROBE_PROFILE ? { profile: true } : {}),
    };
    void pool.build(request)
      .then((result) => createPatch(result, epoch, heroInputKey))
      .catch(() => undefined)
      .finally(() => {
        // A disposed epoch's callback must not remove a new epoch's reservation.
        if (buildRequestsRef.current.get(key) === token) buildRequestsRef.current.delete(key);
      });
  };

  const requestChildren = (address: TerrainNodeAddress, epoch: number): void => {
    for (const child of childrenOf(address)) ensurePatch(child, epoch);
  };

  // Best-effort and independent of the base-terrain init chain below: hero
  // blending is a pure enhancement, so a slow or failed manifest fetch must
  // never delay or block root-tile loading.
  const ensureHeroManifest = (): void => {
    if (heroManifestRef.current !== null || heroManifestRequestRef.current !== null) return;
    heroManifestRequestRef.current = loadHeroManifest(HERO_MANIFEST_URL)
      .then((manifest) => { heroManifestRef.current = manifest; })
      // A failed fetch stores an empty manifest rather than leaving this
      // null — otherwise every frame would retry the same failing request
      // forever instead of just leaving hero blending permanently absent.
      .catch(() => { heroManifestRef.current = { regions: [] }; })
      .finally(() => { heroManifestRequestRef.current = null; });
  };

  const startTerrain = (): void => {
    ensureHeroManifest();
    // Guard against re-creating a live pool: without it, this runs again
    // every frame the moment the prior async init settles (root tiles are
    // usually already cached, so that's within a frame or two), leaking a
    // fresh set of real Worker instances each time.
    if (initializationRef.current !== null || poolRef.current !== null) return;
    setCoverageReady(false);
    const epoch = epochRef.current;
    initializationRef.current = (async () => {
      if (sourceRef.current === null) {
        const manifest = await loadManifest(BASE_MANIFEST_URL);
        if (epoch !== epochRef.current) return;
        sourceRef.current = new TerrainTileSource(manifest, { byteBudget: TERRAIN_TILE_CACHE_BUDGET_BYTES });
      }
      if (epoch !== epochRef.current || sourceRef.current === null) return;
      // Re-assign every time, not just on first creation: the fade-out path
      // below clears sourceRef's cache but keeps the object (to avoid an
      // unnecessary manifest re-fetch), and terrainSourceRef.current needs
      // to track it again on re-entry — otherwise ground-height sampling
      // in CameraRig stays permanently disabled after the first round-trip.
      terrainSourceRef.current = sourceRef.current;
      poolRef.current = new TerrainWorkerPool({ maxConcurrentBuilds: TERRAIN_WORKER_BUILD_CONCURRENCY });
      const source = sourceRef.current;
      rootRequestRef.current = Promise.all(rootTerrainNodes().map((root) => source.request(root)))
        .then(() => {
          for (const root of rootTerrainNodes()) ensurePatch(root, epoch);
        })
        .catch(() => undefined);
      await rootRequestRef.current;
    })().catch(() => undefined).finally(() => {
      initializationRef.current = null;
    });
  };

  useFrame(() => {
    const cameraWorld = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    const cameraFromEarth = subtract(cameraWorld, earthCenterF64);
    const altitudeM = vectorLength(cameraFromEarth) - radius;
    const fade = terrainFadeFromAltitudeM(altitudeM);
    const renderEarthCenter = worldFrame.toRender(earthCenterF64);

    if (fade <= 0 || altitudeM > TERRAIN_ENGAGEMENT_ALTITUDE_M) {
      setCoverageReady(false);
      renderTimings.setTerrainState(0, 0, 0, 0, 0, 0, false);
      if (poolRef.current !== null || recordsRef.current.size > 0 || initializationRef.current !== null) {
        epochRef.current += 1;
        poolRef.current?.dispose();
        poolRef.current = null;
        sourceRef.current?.clear();
        terrainSourceRef.current = null;
        rootRequestRef.current = null;
        disposeAll();
      }
      desiredRef.current = [];
      desiredIndexRef.current = indexDesiredTerrain([]);
      selectionInputsRef.current = [];
      reconciliationDirtyRef.current = true;
      return;
    }

    const projectionScalePx = Math.abs(camera.projectionMatrix.elements[5]) * size.height * 0.5;
    const inputs = [...cameraFromEarth, radius, projectionScalePx, SKY_CONFIG.terrain.screenSpaceErrorPx, TERRAIN_MAX_LEVEL, TERRAIN_MAX_LIVE_PATCHES];
    if (inputs.some((value, i) => value !== selectionInputsRef.current[i])) {
      const selectionStartedAt = renderTimings.start('terrain.selection');
      try {
        const desired = selectTerrainNodes(cameraFromEarth, {
          planetRadiusM: radius,
          projectionScalePx,
          splitThresholdPx: SKY_CONFIG.terrain.screenSpaceErrorPx,
          maxLevel: TERRAIN_MAX_LEVEL,
          maxLivePatches: TERRAIN_MAX_LIVE_PATCHES,
          horizonCulling: true,
        });
        if (!sameNodes(desired, desiredRef.current)) {
          desiredRef.current = desired;
          desiredIndexRef.current = indexDesiredTerrain(desired);
          desiredResidencyRef.current = terrainResidencyKeys(desired);
          reconciliationDirtyRef.current = true;
          poolRef.current?.cancelQueued((request) => !desiredResidencyRef.current.has(nodeAddressKey(request.address)));
        }
        selectionInputsRef.current = inputs;
      } finally {
        renderTimings.end('terrain.selection', selectionStartedAt);
      }
    }
    reconcileDisplayed();
    startTerrain();
    for (const root of rootTerrainNodes()) ensurePatch(root, epochRef.current);
    for (const node of displayedRef.current) {
      if (desiredIndexRef.current.splits.has(nodeAddressKey(node))) requestChildren(node, epochRef.current);
    }
    for (const key of dirtyHeroRef.current) {
      const record = recordsRef.current.get(key);
      if (record) ensurePatch(record.result.address, epochRef.current);
    }
    diagTick();

    // Built once per frame so the per-record visibility pass below is an
    // O(1) lookup instead of an O(records * displayed) linear scan that
    // also re-validates + re-allocates a nodeAddressKey string per record
    // per displayed node — real GC pressure at up to 300 live patches.
    const displayedKeys = new Set(displayedRef.current.map(nodeAddressKey));
    for (const record of recordsRef.current.values()) {
      const key = nodeAddressKey(record.result.address);
      const renderCenter = worldFrame.toRender([
        earthCenterF64[0] + record.result.patchCenterF64[0],
        earthCenterF64[1] + record.result.patchCenterF64[1],
        earthCenterF64[2] + record.result.patchCenterF64[2],
      ]);
      record.mesh.position.set(renderCenter[0], renderCenter[1], renderCenter[2]);
      record.mesh.visible = displayedKeys.has(key);
      record.mesh.material.uniforms.planetCenter!.value.fromArray(renderEarthCenter);
      record.mesh.material.uniforms.terrainSurfaceCameraPositionM?.value.fromArray(cameraFromEarth);
    }
    // Publish after placement and visibility, never from an async worker
    // callback while freshly created meshes are still at their default pose.
    const coverageReady = isTerrainCoverageReady(displayedRef.current, readyKeys());
    setCoverageReady(coverageReady);
    renderTimings.setTerrainState(
      recordsRef.current.size,
      displayedRef.current.length,
      desiredRef.current.length,
      buildRequestsRef.current.size,
      poolRef.current?.queuedCount ?? 0,
      poolRef.current?.activeBuildCount ?? 0,
      coverageReady,
    );
  });

  useEffect(() => {
    coverageCallbackRef.current?.(coverageReadyRef.current);
    return () => {
      setCoverageReady(false);
      epochRef.current += 1;
      poolRef.current?.dispose();
      poolRef.current = null;
      sourceRef.current?.clear();
      terrainSourceRef.current = null;
      disposeAll();
      surfaceNoiseRef.current?.dispose();
      surfaceNoiseRef.current = null;
    };
  }, []);

  return <group ref={groupRef} />;
}

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
import {
  neighborAddress,
  nodeAngularRadiusRadians,
  nodeCenterDirection,
  parentAddress,
  nodeAddressKey,
  TERRAIN_EDGES,
  type TerrainEdge,
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
  createWaterMaterial,
  type TerrainShaderTextures,
} from './terrainShaders';
import {
  TerrainWorkerPool,
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
} from './terrainNodeSet';
import { buildWaterPatchGeometry, type WaterPatchGeometry } from './terrainWater';
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
  readonly worldFrame: WorldFrame;
  readonly terrainSourceRef: { current: TerrainTileSource | null };
  readonly earthCenterF64: WorldPositionF64;
  readonly dayMap: Texture;
  readonly cloudMap: Texture;
  readonly transmittanceLut: Texture;
  readonly mainDeckRotation: { current: number };
  readonly radius: number;
}

interface PatchRecord {
  readonly result: PatchBuildResult;
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly waterMesh: Mesh<BufferGeometry, ShaderMaterial> | null;
}

function vectorLength(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function isDescendantOrSelf(candidate: TerrainNodeAddress, ancestor: TerrainNodeAddress): boolean {
  if (candidate.face !== ancestor.face || candidate.level < ancestor.level) return false;
  const shift = candidate.level - ancestor.level;
  return (candidate.x >> shift) === ancestor.x && (candidate.y >> shift) === ancestor.y;
}

function childrenOf(address: TerrainNodeAddress): readonly TerrainNodeAddress[] {
  return [
    { face: address.face, level: address.level + 1, x: address.x * 2, y: address.y * 2 },
    { face: address.face, level: address.level + 1, x: address.x * 2 + 1, y: address.y * 2 },
    { face: address.face, level: address.level + 1, x: address.x * 2, y: address.y * 2 + 1 },
    { face: address.face, level: address.level + 1, x: address.x * 2 + 1, y: address.y * 2 + 1 },
  ];
}

/** True when the edge stays inside the current face (no cross-face neighbor lookup needed). */
function isFaceEdgeInterior(address: TerrainNodeAddress, edge: TerrainEdge): boolean {
  const count = 2 ** address.level;
  return (edge === 'west' && address.x > 0)
    || (edge === 'east' && address.x + 1 < count)
    || (edge === 'south' && address.y > 0)
    || (edge === 'north' && address.y + 1 < count);
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

function meshGeometry(result: PatchBuildResult): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(result.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(result.normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(result.uvs), 2));
  geometry.setIndex(new BufferAttribute(new Uint32Array(result.indices), 1));
  // Worker positions are relative to the patch centre, so the local sphere
  // is centred at zero and remains valid while RTC placement changes.
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), result.boundingSphereRadiusM);
  return geometry;
}

function waterMeshGeometry(data: WaterPatchGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(data.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(data.normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(data.uvs), 2));
  geometry.setAttribute('waterMask', new BufferAttribute(new Float32Array(data.waterMask), 1));
  geometry.setIndex(new BufferAttribute(new Uint32Array(data.indices), 1));
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), data.boundingSphereRadiusM);
  return geometry;
}

/**
 * The live terrain owner. It deliberately performs no manifest/tile/worker
 * work until the camera enters the configured crossfade band.
 */
export function TerrainPatches({
  worldFrame,
  terrainSourceRef,
  earthCenterF64,
  dayMap,
  cloudMap,
  transmittanceLut,
  mainDeckRotation,
  radius,
}: TerrainPatchesProps) {
  const { camera, size } = useThree();
  const groupRef = useRef<Group>(null);
  const sourceRef = useRef<TerrainTileSource | null>(null);
  const poolRef = useRef<TerrainWorkerPool | null>(null);
  const initializationRef = useRef<Promise<void> | null>(null);
  const epochRef = useRef(0);
  const rootRequestRef = useRef<Promise<void> | null>(null);
  const buildRequestsRef = useRef(new Set<string>());
  const waterTimeRef = useRef(0);
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

  const disposeRecord = (key: string): void => {
    diagRef.current.disposed += 1;
    const record = recordsRef.current.get(key);
    if (record === undefined) return;
    groupRef.current?.remove(record.mesh);
    record.mesh.geometry.dispose();
    record.mesh.material.dispose();
    if (record.waterMesh !== null) {
      groupRef.current?.remove(record.waterMesh);
      record.waterMesh.geometry.dispose();
      record.waterMesh.material.dispose();
    }
    recordsRef.current.delete(key);
  };

  const disposeAll = (): void => {
    for (const key of recordsRef.current.keys()) disposeRecord(key);
    displayedRef.current = [];
    buildRequestsRef.current.clear();
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
    }));
  };

  const reconcileDisplayed = (): void => {
    const desired = desiredRef.current;
    const ready = readyKeys();
    let next = mergeCompleteSiblings(displayedRef.current, desired, ready);
    next = swapCompleteSiblings(next, desired, ready);
    const roots = rootTerrainNodes();
    if (next.length === 0 && roots.every((root) => ready.has(nodeAddressKey(root)))) next = roots;
    // Undisplayed records stay RESIDENT (hidden by the per-frame visibility
    // pass) — disposing them here rebuilt still-desired patches on the next
    // tick, and the resulting build/dispose oscillation churned GPU uploads
    // and shader inits until the GPU process wedged. Retirement is the cap
    // eviction's job below, never the display reconcile's.
    displayedRef.current = next;
    evictOverBudget();
  };

  const evictOverBudget = (): void => {
    const over = recordsRef.current.size - TERRAIN_MAX_LIVE_PATCHES;
    if (over <= 0) return;
    const displayedKeys = new Set(displayedRef.current.map(nodeAddressKey));
    // Only records that are neither displayed NOR desired may be retired.
    // Evicting a desired record (e.g., children staged for a sibling swap)
    // makes ensurePatch rebuild it immediately — the same build/dispose
    // oscillation the reconcile fix removed, relocated to eviction.
    const desiredKeys = new Set<string>();
    for (const node of desiredRef.current) {
      desiredKeys.add(nodeAddressKey(node));
      let ancestor = parentAddress(node);
      while (ancestor !== null) {
        desiredKeys.add(nodeAddressKey(ancestor));
        ancestor = parentAddress(ancestor);
      }
    }
    const candidates = [...recordsRef.current.keys()]
      .filter((key) => !displayedKeys.has(key) && !desiredKeys.has(key))
      .sort((a, b) => Number(b.split('/')[1]) - Number(a.split('/')[1]));
    for (const key of candidates.slice(0, over)) disposeRecord(key);
  };

  const createPatch = (result: PatchBuildResult, epoch: number, force = false): void => {
    diagRef.current.built += 1;
    if (epoch !== epochRef.current) return;
    const key = nodeAddressKey(result.address);
    if (recordsRef.current.has(key)) return;
    // A build may finish after the camera has moved away. Do not turn stale
    // queued work into live GPU resources or let it defeat the patch budget.
    // `force` (roots only — see ensurePatch) must match: a root built with
    // the desired-set filter bypassed at the start would otherwise be
    // discarded here anyway, then immediately re-requested by the per-frame
    // root sweep, forever — this was silently building and discarding a
    // root every frame instead of ever keeping it.
    if (!force && desiredRef.current.length > 0
      && !desiredRef.current.some((node) => isDescendantOrSelf(node, result.address))) return;
    const geometry = meshGeometry(result);
    const material = createTerrainPatchMaterial(
      { dayMap, cloudMap, transmittanceLut } satisfies TerrainShaderTextures,
      {
        planetCenter: worldFrame.toRender(earthCenterF64),
        surfaceRadius: radius,
        atmosphereRadius: radius * SKY_DERIVED.atmosphereRadiusMultiplier,
      },
    );
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = true;
    mesh.renderOrder = 0.5;
    groupRef.current?.add(mesh);
    const waterData = buildWaterPatchGeometry(result, radius);
    let waterMesh: Mesh<BufferGeometry, ShaderMaterial> | null = null;
    if (waterData.hasWater) {
      const waterGeometry = waterMeshGeometry(waterData);
      const waterMaterial = createWaterMaterial({
        planetCenter: worldFrame.toRender(earthCenterF64),
        surfaceRadius: radius,
        atmosphereRadius: radius * SKY_DERIVED.atmosphereRadiusMultiplier,
      });
      waterMesh = new Mesh(waterGeometry, waterMaterial);
      waterMesh.visible = false; // ISOLATION: built but never rendered
      waterMesh.frustumCulled = true;
      waterMesh.renderOrder = 0.6;
      groupRef.current?.add(waterMesh);
    }
    recordsRef.current.set(key, { result, mesh, waterMesh });
    reconcileDisplayed();
  };

  const gatherTiles = (address: TerrainNodeAddress): readonly PatchBuildRequest['tiles'][number][] => {
    const source = sourceRef.current;
    if (source === null) return [];
    const tiles = new Map<string, PatchBuildRequest['tiles'][number]>();
    const addResidentChain = (start: TerrainNodeAddress): void => {
      let current: TerrainNodeAddress | null = start;
      while (current !== null) {
        const tile = source.get(current);
        if (tile !== undefined) tiles.set(nodeAddressKey(tile.address), tile);
        current = parentAddress(current);
      }
    };
    // Own-face ancestor chain always matters for continuity within the
    // patch. Cross-face neighbors only matter — and are only worth their
    // structured-clone cost — when the patch actually sits on a face seam;
    // neighborAddress() (quadtree.ts) resolves the true adjacent-face
    // address rather than reusing this patch's own x/y on another face.
    addResidentChain(address);
    for (const edge of TERRAIN_EDGES) {
      if (isFaceEdgeInterior(address, edge)) continue;
      addResidentChain(neighborAddress(address, edge));
    }
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

  // `force` bypasses the desired-set filter — only for the 6 cube-face
  // roots (see the per-frame root sweep below): they're the fixed,
  // bounded base every deeper split needs to exist before it can run, not
  // camera-dependent detail, so an off-camera root skipping the filter
  // (and never getting built at all) can't be allowed to leave the whole
  // face permanently unsplittable the moment the camera turns toward it.
  const ensurePatch = (address: TerrainNodeAddress, epoch: number, force = false): void => {
    const key = nodeAddressKey(address);
    if (recordsRef.current.has(key) || buildRequestsRef.current.has(key)) return;
    if (!force && desiredRef.current.length > 0
      && !desiredRef.current.some((node) => isDescendantOrSelf(node, address))) return;
    const source = sourceRef.current;
    const pool = poolRef.current;
    if (source === null || pool === null) return;
    // Geometry LOD is deliberately decoupled from raster LOD: below the
    // manifest's deepest tile level no exact tile exists for this address,
    // and sampleResidentTerrain() already walks up to the finest resident
    // ancestor (procedural detail supplies the sub-raster relief). Requiring
    // an exact tile here pinned ALL geometry to the raster's level.
    const tiles = gatherTiles(address);
    if (tiles.length === 0) return;
    buildRequestsRef.current.add(key);
    const request: Omit<PatchBuildRequest, 'requestId'> = {
      type: 'buildPatch',
      address,
      tiles,
      codec: source.manifest.codec,
      heroRegions: SKY_CONFIG.terrain.heroRegions.map((region): PatchHeroRegionConfig => ({ ...region })),
      heroTiles: gatherHeroTiles(address),
      planetRadiusM: EARTH_RADIUS_M,
    };
    void pool.build(request)
      .then((result) => createPatch(result, epoch, force))
      .catch(() => undefined)
      .finally(() => buildRequestsRef.current.delete(key));
  };

  const requestChildren = (address: TerrainNodeAddress, epoch: number): void => {
    const source = sourceRef.current;
    if (source === null) return;
    // Tile FETCH only goes as deep as the raster pyramid; geometry levels
    // below that sample the finest resident ancestor instead, so this gate
    // must not also gate the child-patch builds at the end of this function.
    if (address.level >= source.manifest.maxLevel) {
      for (const child of childrenOf(address)) ensurePatch(child, epoch, true);
      return;
    }
    // Gated on LIVE residency (isSplitReady), not "have we ever asked": a
    // lifetime marker would either wedge forever once a previously-fetched
    // child is evicted from the LRU cache (marker says done, tile says
    // missing), or — if cleared too eagerly — re-fetch every frame for a
    // parent that can never fully complete (the original OOM, ~300
    // requests/s). isSplitReady() is 4 cheap Map lookups, and request()/
    // requestChildren() already dedupe in-flight and already-resident
    // tiles internally (tileSource.ts's own `pending` map), so calling
    // this every frame is safe and only does real work when genuinely
    // needed — including correctly re-fetching an evicted child.
    if (!source.isSplitReady(address)) {
      diagRef.current.requested += 1;
      void source.requestChildren(address).catch(() => undefined);
    }
    // Retried every frame this parent still wants a descendant. ensurePatch()
    // is already a cheap no-op once a child is built, mid-build, or still
    // undesired, so this is what lets a child skipped for any reason
    // (including an evicted record, or a worker build that failed) actually
    // get built once it's genuinely buildable.
    //
    // force: a sibling quartet is structurally all-or-nothing. swapCompleteSiblings
    // only promotes a parent once ALL FOUR children are built (the no-hole
    // rule), so letting the desired-set filter skip the siblings that don't
    // themselves contain a desired node deadlocks refinement permanently:
    // near the ground, horizon culling leaves only 1-2 desired nodes, so 3 of
    // every 4 siblings were never built, the quartet never completed, and the
    // scene stayed pinned to the six level-0 roots (~312 km per vertex).
    // Undesired siblings are still retired normally by evictOverBudget.
    for (const child of childrenOf(address)) ensurePatch(child, epoch, true);
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
          for (const root of rootTerrainNodes()) ensurePatch(root, epoch, true);
        })
        .catch(() => undefined);
      await rootRequestRef.current;
    })().finally(() => {
      initializationRef.current = null;
    });
  };

  useFrame((_, delta) => {
    waterTimeRef.current += delta;
    const cameraWorld = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    const cameraFromEarth = subtract(cameraWorld, earthCenterF64);
    const altitudeM = vectorLength(cameraFromEarth) - radius;
    const fade = terrainFadeFromAltitudeM(altitudeM);
    const renderEarthCenter = worldFrame.toRender(earthCenterF64);

    if (fade <= 0 || altitudeM > TERRAIN_ENGAGEMENT_ALTITUDE_M) {
      if (poolRef.current !== null || recordsRef.current.size > 0) {
        epochRef.current += 1;
        poolRef.current?.dispose();
        poolRef.current = null;
        sourceRef.current?.clear();
        terrainSourceRef.current = null;
        rootRequestRef.current = null;
        disposeAll();
      }
      desiredRef.current = [];
      return;
    }

    startTerrain();
    // Retried every frame, same pattern as requestChildren() for a deeper
    // split: this recovers a root whose worker build failed (e.g. a
    // terrain worker error), which startTerrain()'s one-shot init would
    // otherwise never retry once the pool already exists. Gated on live
    // residency/in-flight state, not just called unconditionally, so a
    // healthy already-built root costs nothing per frame beyond the
    // recordsRef lookup inside ensurePatch. force:true bypasses the
    // desired-set filter — see ensurePatch's comment for why.
    if (sourceRef.current !== null && poolRef.current !== null) {
      const source = sourceRef.current;
      for (const root of rootTerrainNodes()) {
        if (!source.isResident(root) && !source.isPending(root)) {
          void source.request(root).catch(() => undefined);
        }
        ensurePatch(root, epochRef.current, true);
      }
    }
    diagTick();
    const projectionScalePx = Math.abs(camera.projectionMatrix.elements[5]) * size.height * 0.5;
    desiredRef.current = selectTerrainNodes(cameraFromEarth, {
      planetRadiusM: radius,
      projectionScalePx,
      splitThresholdPx: SKY_CONFIG.terrain.screenSpaceErrorPx,
      // Geometry cap only — deliberately NOT clamped to the raster's max
      // level (see ensurePatch): the pyramid stops at ~2 km/px, while
      // geometry must keep subdividing to reach ground scale.
      maxLevel: TERRAIN_MAX_LEVEL,
      maxLivePatches: TERRAIN_MAX_LIVE_PATCHES,
      horizonCulling: true,
    });

    for (const node of displayedRef.current) {
      const wantsDescendant = desiredRef.current.some((candidate) => candidate.level > node.level
        && isDescendantOrSelf(candidate, node));
      if (wantsDescendant) requestChildren(node, epochRef.current);
    }
    reconcileDisplayed();

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
      record.mesh.visible = displayedKeys.has(key)
        && isTerrainNodeHorizonVisible(record.result.address, cameraFromEarth, radius);
      record.mesh.material.uniforms.planetCenter!.value.fromArray(renderEarthCenter);
      record.mesh.material.uniforms.terrainOpacity!.value = fade;
      record.mesh.material.uniforms.cloudRotationOffset!.value = mainDeckRotation.current;
      if (record.waterMesh !== null) {
        record.waterMesh.position.set(renderCenter[0], renderCenter[1], renderCenter[2]);
        record.waterMesh.visible = record.mesh.visible;
        record.waterMesh.material.uniforms.planetCenter!.value.fromArray(renderEarthCenter);
        record.waterMesh.material.uniforms.terrainOpacity!.value = fade;
        record.waterMesh.material.uniforms.oceanTime!.value = waterTimeRef.current;
      }
    }

  });

  useEffect(() => () => {
    epochRef.current += 1;
    poolRef.current?.dispose();
    poolRef.current = null;
    sourceRef.current?.clear();
    terrainSourceRef.current = null;
    disposeAll();
  }, []);

  return <group ref={groupRef} />;
}

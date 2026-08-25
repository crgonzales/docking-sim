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
import { parentAddress, nodeAddressKey, type TerrainNodeAddress, type Vec3 } from './quadtree';
import {
  TerrainTileSource,
  type TerrainTileManifest,
} from './tileSource';
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
  const splitRequestsRef = useRef(new Set<string>());
  const buildRequestsRef = useRef(new Set<string>());
  const waterTimeRef = useRef(0);
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
    splitRequestsRef.current.clear();
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
      splitsInFlight: splitRequestsRef.current.size,
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

  const createPatch = (result: PatchBuildResult, epoch: number): void => {
    diagRef.current.built += 1;
    if (epoch !== epochRef.current) return;
    const key = nodeAddressKey(result.address);
    if (recordsRef.current.has(key)) return;
    // A build may finish after the camera has moved away. Do not turn stale
    // queued work into live GPU resources or let it defeat the patch budget.
    if (desiredRef.current.length > 0
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
    let levelAddress: TerrainNodeAddress | null = address;
    while (levelAddress !== null) {
      for (const face of rootTerrainNodes()) {
        const candidate: TerrainNodeAddress = levelAddress.level === 0
          ? face
          : { face: face.face, level: levelAddress.level, x: levelAddress.x, y: levelAddress.y };
        const tile = source.get(candidate);
        if (tile !== undefined) tiles.set(nodeAddressKey(tile.address), tile);
      }
      levelAddress = parentAddress(levelAddress);
    }
    return [...tiles.values()];
  };

  const ensurePatch = (address: TerrainNodeAddress, epoch: number): void => {
    const key = nodeAddressKey(address);
    if (recordsRef.current.has(key) || buildRequestsRef.current.has(key)) return;
    if (desiredRef.current.length > 0
      && !desiredRef.current.some((node) => isDescendantOrSelf(node, address))) return;
    const source = sourceRef.current;
    const pool = poolRef.current;
    if (source === null || pool === null) return;
    const tiles = gatherTiles(address);
    const tile = source.get(address);
    if (tile === undefined || tiles.length === 0) return;
    buildRequestsRef.current.add(key);
    const request: Omit<PatchBuildRequest, 'requestId'> = {
      type: 'buildPatch',
      address,
      tiles,
      codec: source.manifest.codec,
      heroRegions: SKY_CONFIG.terrain.heroRegions.map((region): PatchHeroRegionConfig => ({ ...region })),
      planetRadiusM: EARTH_RADIUS_M,
    };
    void pool.build(request)
      .then((result) => createPatch(result, epoch))
      .catch(() => undefined)
      .finally(() => buildRequestsRef.current.delete(key));
  };

  const requestChildren = (address: TerrainNodeAddress, epoch: number): void => {
    const source = sourceRef.current;
    if (source === null || address.level >= source.manifest.maxLevel) return;
    const key = nodeAddressKey(address);
    if (splitRequestsRef.current.has(key)) return;
    splitRequestsRef.current.add(key);
    diagRef.current.requested += 1;
    // ONCE per node per epoch: clearing the key on completion made every
    // frame re-fire this for parents whose sibling set can never complete
    // (~300 requests/s of fetch promises and cloned tile payloads — the
    // renderer OOM'd within ~30 s). The key stays; only a FAILED request is
    // cleared so a transient fetch error can retry.
    void source.requestChildren(address)
      .then(() => {
        for (const child of [
          { face: address.face, level: address.level + 1, x: address.x * 2, y: address.y * 2 },
          { face: address.face, level: address.level + 1, x: address.x * 2 + 1, y: address.y * 2 },
          { face: address.face, level: address.level + 1, x: address.x * 2, y: address.y * 2 + 1 },
          { face: address.face, level: address.level + 1, x: address.x * 2 + 1, y: address.y * 2 + 1 },
        ] as TerrainNodeAddress[]) ensurePatch(child, epoch);
      })
      .catch(() => splitRequestsRef.current.delete(key));
  };

  const startTerrain = (): void => {
    if (initializationRef.current !== null) return;
    const epoch = epochRef.current;
    initializationRef.current = (async () => {
      if (sourceRef.current === null) {
        const manifest = await loadManifest(BASE_MANIFEST_URL);
        if (epoch !== epochRef.current) return;
        sourceRef.current = new TerrainTileSource(manifest, { byteBudget: TERRAIN_TILE_CACHE_BUDGET_BYTES });
        terrainSourceRef.current = sourceRef.current;
      }
      if (epoch !== epochRef.current || sourceRef.current === null) return;
      poolRef.current = new TerrainWorkerPool({ maxConcurrentBuilds: TERRAIN_WORKER_BUILD_CONCURRENCY });
      const source = sourceRef.current;
      rootRequestRef.current = Promise.all(rootTerrainNodes().map((root) => source.request(root)))
        .then(() => {
          for (const root of rootTerrainNodes()) ensurePatch(root, epoch);
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
    diagTick();
    const projectionScalePx = Math.abs(camera.projectionMatrix.elements[5]) * size.height * 0.5;
    desiredRef.current = selectTerrainNodes(cameraFromEarth, {
      planetRadiusM: radius,
      projectionScalePx,
      splitThresholdPx: SKY_CONFIG.terrain.screenSpaceErrorPx,
      maxLevel: Math.min(TERRAIN_MAX_LEVEL, sourceRef.current?.manifest.maxLevel ?? TERRAIN_MAX_LEVEL),
      maxLivePatches: TERRAIN_MAX_LIVE_PATCHES,
      horizonCulling: true,
    });

    for (const node of displayedRef.current) {
      const wantsDescendant = desiredRef.current.some((candidate) => candidate.level > node.level
        && isDescendantOrSelf(candidate, node));
      if (wantsDescendant) requestChildren(node, epochRef.current);
    }
    reconcileDisplayed();

    for (const record of recordsRef.current.values()) {
      const key = nodeAddressKey(record.result.address);
      const renderCenter = worldFrame.toRender([
        earthCenterF64[0] + record.result.patchCenterF64[0],
        earthCenterF64[1] + record.result.patchCenterF64[1],
        earthCenterF64[2] + record.result.patchCenterF64[2],
      ]);
      record.mesh.position.set(renderCenter[0], renderCenter[1], renderCenter[2]);
      record.mesh.visible = displayedRef.current.some((node) => nodeAddressKey(node) === key)
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

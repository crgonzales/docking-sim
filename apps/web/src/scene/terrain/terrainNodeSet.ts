import {
  childAddress,
  decideLod,
  nodeAddressKey,
  nodeAngularRadiusRadians,
  nodeCenterDirection,
  parentAddress,
  type TerrainNodeAddress,
  type TerrainLodOptions,
  type Vec3,
} from './quadtree';
import { SKY_DERIVED, TERRAIN_MAX_LEVEL, TERRAIN_MAX_LIVE_PATCHES } from '../sky/skyConfig';

const ROOT_NODES: readonly TerrainNodeAddress[] = [0, 1, 2, 3, 4, 5].map((face) => ({
  face: face as TerrainNodeAddress['face'],
  level: 0,
  x: 0,
  y: 0,
}));

export interface TerrainNodeSelectionOptions extends TerrainLodOptions {
  readonly planetRadiusM?: number;
  readonly maxLevel?: number;
  readonly horizonCulling?: boolean;
  /** Budget for all six roots, coverage siblings AND retained ancestors. */
  readonly maxLivePatches?: number;
  /** Optional operation counter for CPU regression checks (no timing dependency). */
  readonly statistics?: { evaluatedNodes: number; splits: number; residentNodes: number };
}

function length(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distanceSquared(a: Vec3, b: Vec3): number {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
}

// Numeric comparator over the raw address fields: avoids allocating and
// validating a nodeAddressKey string (and localeCompare's locale-aware
// collation) on every pairwise comparison of these hot sort calls.
function compareNodeAddress(a: TerrainNodeAddress, b: TerrainNodeAddress): number {
  return a.face - b.face || a.level - b.level || a.x - b.x || a.y - b.y;
}

function nodeCenterPosition(address: TerrainNodeAddress, planetRadiusM: number): Vec3 {
  const direction = nodeCenterDirection(address);
  return [direction[0] * planetRadiusM, direction[1] * planetRadiusM, direction[2] * planetRadiusM];
}

/** Keep the closest nodes while making equal-distance seams deterministic. */
export function capTerrainNodes(
  nodes: readonly TerrainNodeAddress[],
  cameraPosition: Vec3,
  maxLivePatches: number,
  planetRadiusM = SKY_DERIVED.earthRadiusM,
): readonly TerrainNodeAddress[] {
  if (!Number.isSafeInteger(maxLivePatches) || maxLivePatches < 0) {
    throw new Error(`Terrain maxLivePatches must be a non-negative integer, received ${maxLivePatches}`);
  }
  if (maxLivePatches >= nodes.length) return [...nodes];
  // Collapse deepest-and-farthest sibling quartets into their parent until the
  // set fits, rather than truncating to the nearest N. Truncating DELETED the
  // far field outright: near the ground the nearest N leaves are all at max
  // level (a level-16 patch is ~153 m across, so 300 of them span ~2.6 km),
  // leaving a tiny high-detail apron with bare space beyond it — terrain
  // showed up as a thin band at the horizon and nothing else. Collapsing
  // preserves exact coverage (four children tile their parent) and just
  // lowers detail where it is least missed.
  let current = [...nodes];
  while (current.length > maxLivePatches) {
    let deepest = 0;
    for (const node of current) if (node.level > deepest) deepest = node.level;
    if (deepest === 0) break;
    const groups = new Map<string, { parent: TerrainNodeAddress; members: TerrainNodeAddress[]; distance: number }>();
    for (const node of current) {
      if (node.level !== deepest) continue;
      const parent = parentAddress(node);
      if (parent === null) continue;
      const key = nodeAddressKey(parent);
      const existing = groups.get(key);
      if (existing !== undefined) existing.members.push(node);
      else {
        groups.set(key, {
          parent,
          members: [node],
          distance: distanceSquared(cameraPosition, nodeCenterPosition(parent, planetRadiusM)),
        });
      }
    }
    if (groups.size === 0) break;
    const farthestFirst = [...groups.values()].sort((a, b) => b.distance - a.distance);
    const removed = new Set<string>();
    const added: TerrainNodeAddress[] = [];
    for (const group of farthestFirst) {
      if (current.length - removed.size + added.length <= maxLivePatches) break;
      for (const member of group.members) removed.add(nodeAddressKey(member));
      added.push(group.parent);
    }
    if (added.length === 0) break;
    current = current.filter((node) => !removed.has(nodeAddressKey(node))).concat(added);
  }
  return current.sort(compareNodeAddress);
}

/** Conservative spherical horizon test, expanded by the node's angular radius. */
export function isTerrainNodeHorizonVisible(
  address: TerrainNodeAddress,
  cameraPosition: Vec3,
  planetRadiusM = SKY_DERIVED.earthRadiusM,
): boolean {
  const cameraDistance = length(cameraPosition);
  if (!Number.isFinite(cameraDistance) || cameraDistance <= planetRadiusM) return true;
  const cameraDirection: Vec3 = [
    cameraPosition[0] / cameraDistance,
    cameraPosition[1] / cameraDistance,
    cameraPosition[2] / cameraDistance,
  ];
  const center = nodeCenterDirection(address);
  const centerAngle = Math.acos(Math.max(-1, Math.min(1, dot(cameraDirection, center))));
  const horizonAngle = Math.acos(Math.min(1, planetRadiusM / cameraDistance));
  return centerAngle <= horizonAngle + nodeAngularRadiusRadians(address);
}

/** The entire resident closure needed for atomic splits and later coarsening. */
export function terrainResidencyKeys(nodes: readonly TerrainNodeAddress[]): Set<string> {
  const keys = new Set<string>();
  for (const leaf of nodes) {
    let node: TerrainNodeAddress | null = leaf;
    while (node !== null) {
      const key = nodeAddressKey(node);
      if (keys.has(key)) break;
      keys.add(key);
      node = parentAddress(node);
    }
  }
  return keys;
}

/** Full, non-overlapping six-face cover, with every displayed mesh ready. */
export function isTerrainCoverageReady(nodes: readonly TerrainNodeAddress[], ready: ReadonlySet<string>): boolean {
  const areas = [0, 0, 0, 0, 0, 0];
  const leaves = new Set(nodes.map(nodeAddressKey));
  if (leaves.size !== nodes.length) return false;
  for (const node of nodes) {
    if (!ready.has(nodeAddressKey(node))) return false;
    areas[node.face] += 4 ** -node.level;
    let parent = parentAddress(node);
    while (parent !== null) {
      if (leaves.has(nodeAddressKey(parent))) return false;
      parent = parentAddress(parent);
    }
  }
  return areas.every((area) => area === 1);
}

/**
 * Bounded best-first frontier. Every split reserves FOUR additional resident
 * records: all siblings, while retaining their parent for fallback/coarsening.
 * Roots and unsplit siblings stay in the cover even beyond the horizon; only
 * refinement is horizon-culled. No full-depth tree is generated then capped.
 */
export function selectTerrainNodes(
  cameraPosition: Vec3,
  options: TerrainNodeSelectionOptions = {},
): readonly TerrainNodeAddress[] {
  const planetRadiusM = options.planetRadiusM ?? SKY_DERIVED.earthRadiusM;
  const maxLevel = options.maxLevel ?? TERRAIN_MAX_LEVEL;
  const budget = options.maxLivePatches ?? TERRAIN_MAX_LIVE_PATCHES;
  if (!Number.isSafeInteger(budget) || budget < ROOT_NODES.length) {
    throw new Error('Terrain residency budget must accommodate all six roots');
  }
  const statistics = options.statistics;
  if (statistics) Object.assign(statistics, { evaluatedNodes: 0, splits: 0, residentNodes: 6 });
  const lodOptions = { ...options, planetRadiusM, maxLevel };
  const leaves = new Map(ROOT_NODES.map((node) => [nodeAddressKey(node), node]));
  type Candidate = { node: TerrainNodeAddress; error: number };
  const heap: Candidate[] = [];
  const before = (a: Candidate, b: Candidate): boolean => a.error > b.error
    || (a.error === b.error && compareNodeAddress(a.node, b.node) < 0);
  const offer = (node: TerrainNodeAddress): void => {
    if (statistics) statistics.evaluatedNodes += 1;
    if ((options.horizonCulling ?? true) && !isTerrainNodeHorizonVisible(node, cameraPosition, planetRadiusM)) return;
    const lod = decideLod(node, cameraPosition, lodOptions);
    if (lod.action !== 'split' || node.level >= maxLevel) return;
    const candidate = { node, error: lod.screenSpaceErrorPx };
    let index = heap.length;
    heap.push(candidate);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(candidate, heap[parent])) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = candidate;
  };
  const take = (): Candidate => {
    const first = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child += 1;
        if (!before(heap[child], last)) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  for (const root of ROOT_NODES) offer(root);
  let residentNodes = ROOT_NODES.length;
  while (heap.length > 0 && residentNodes + 4 <= budget) {
    const { node } = take();
    leaves.delete(nodeAddressKey(node));
    residentNodes += 4;
    if (statistics) {
      statistics.splits += 1;
      statistics.residentNodes = residentNodes;
    }
    for (const x of [0, 1] as const) for (const y of [0, 1] as const) {
      const child = childAddress(node, x, y);
      leaves.set(nodeAddressKey(child), child);
      offer(child);
    }
  }
  return [...leaves.values()].sort(compareNodeAddress);
}

export interface DesiredTerrainIndex {
  readonly leaves: ReadonlySet<string>;
  readonly splits: ReadonlySet<string>;
}

/** Compile ancestry once per desired cover, including sparse oracle inputs. */
export function indexDesiredTerrain(nodes: readonly TerrainNodeAddress[]): DesiredTerrainIndex {
  const leaves = new Set(nodes.map(nodeAddressKey));
  const splits = new Set<string>();
  for (const node of nodes) {
    let parent = parentAddress(node);
    while (parent !== null) {
      const key = nodeAddressKey(parent);
      if (splits.has(key)) break;
      splits.add(key);
      parent = parentAddress(parent);
    }
  }
  return { leaves, splits };
}

function hasDesiredAncestor(node: TerrainNodeAddress, index: DesiredTerrainIndex): boolean {
  let ancestor: TerrainNodeAddress | null = node;
  while (ancestor !== null) {
    if (index.leaves.has(nodeAddressKey(ancestor))) return true;
    ancestor = parentAddress(ancestor);
  }
  return false;
}

/**
 * Replace a displayed parent once all four direct children have a completed
 * patch and at least one of them is wanted. This is the no-hole swap oracle:
 * hole-freeness comes from the four children exactly tiling the parent, so
 * every child must be READY — but requiring every child to also be DESIRED
 * deadlocked refinement outright. Near the ground the desired set is a small
 * cluster under the camera, so only one child of a given parent ever contains
 * a desired node; demanding all four pinned the scene to the six level-0
 * roots (~312 km per vertex) forever. One wanted child is what says "the
 * camera wants more detail somewhere in here"; mergeCompleteSiblings handles
 * collapsing back when the parent itself becomes the wanted level.
 */
export function swapCompleteSiblings(
  displayed: readonly TerrainNodeAddress[],
  desired: readonly TerrainNodeAddress[],
  ready: ReadonlySet<string>,
  index = indexDesiredTerrain(desired),
): readonly TerrainNodeAddress[] {
  const next: TerrainNodeAddress[] = [];
  for (const node of displayed) {
    if (!index.splits.has(nodeAddressKey(node))) {
      next.push(node);
      continue;
    }
    const children = [
      childAddress(node, 0, 0),
      childAddress(node, 1, 0),
      childAddress(node, 0, 1),
      childAddress(node, 1, 1),
    ];
    const canSwap = children.every((child) => ready.has(nodeAddressKey(child)));
    if (canSwap) next.push(...children);
    else next.push(node);
  }
  return next.sort(compareNodeAddress);
}

/** Coarsen toward a wanted ancestor, including camera jumps across many levels. */
export function mergeCompleteSiblings(
  displayed: readonly TerrainNodeAddress[],
  desired: readonly TerrainNodeAddress[],
  ready: ReadonlySet<string>,
  index = indexDesiredTerrain(desired),
): readonly TerrainNodeAddress[] {
  const displayedKeys = new Set(displayed.map(nodeAddressKey));
  const consumed = new Set<string>();
  const next: TerrainNodeAddress[] = [];
  for (const node of displayed) {
    const key = nodeAddressKey(node);
    if (consumed.has(key)) continue;
    if (node.level === 0) {
      next.push(node);
      continue;
    }
    const parent: TerrainNodeAddress = {
      face: node.face,
      level: node.level - 1,
      x: Math.floor(node.x / 2),
      y: Math.floor(node.y / 2),
    };
    const children = [
      childAddress(parent, 0, 0),
      childAddress(parent, 1, 0),
      childAddress(parent, 0, 1),
      childAddress(parent, 1, 1),
    ];
    const childKeys = children.map(nodeAddressKey);
    const canMerge = hasDesiredAncestor(parent, index)
      && ready.has(nodeAddressKey(parent))
      && childKeys.every((childKey) => displayedKeys.has(childKey));
    if (canMerge) {
      next.push(parent);
      for (const childKey of childKeys) consumed.add(childKey);
    } else {
      next.push(node);
    }
  }
  return next.sort(compareNodeAddress);
}

export function rootTerrainNodes(): readonly TerrainNodeAddress[] {
  return ROOT_NODES;
}

export function retiredTerrainNodeKeys(
  previous: readonly TerrainNodeAddress[],
  next: readonly TerrainNodeAddress[],
): readonly string[] {
  const nextKeys = new Set(next.map(nodeAddressKey));
  return previous
    .map(nodeAddressKey)
    .filter((key) => !nextKeys.has(key))
    .sort();
}

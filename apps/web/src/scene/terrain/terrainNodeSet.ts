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
import { SKY_DERIVED, TERRAIN_MAX_LEVEL } from '../sky/skyConfig';

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
  /** Hard upper bound on the live leaf set, prioritized nearest-first. */
  readonly maxLivePatches?: number;
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

/**
 * Deterministic front-to-back-independent leaf selection. The caller owns
 * residency/build gating; this function only answers what the camera would
 * like to see, which keeps LOD decisions reproducible across worker timing.
 */
export function selectTerrainNodes(
  cameraPosition: Vec3,
  options: TerrainNodeSelectionOptions = {},
): readonly TerrainNodeAddress[] {
  const planetRadiusM = options.planetRadiusM ?? SKY_DERIVED.earthRadiusM;
  const maxLevel = options.maxLevel ?? TERRAIN_MAX_LEVEL;
  const horizonCulling = options.horizonCulling ?? true;
  const selected: TerrainNodeAddress[] = [];
  const visit = (address: TerrainNodeAddress): void => {
    if (horizonCulling && !isTerrainNodeHorizonVisible(address, cameraPosition, planetRadiusM)) return;
    const lod = decideLod(address, cameraPosition, {
      ...options,
      planetRadiusM,
      maxLevel,
    });
    if (lod.action === 'split' && address.level < maxLevel) {
      visit(childAddress(address, 0, 0));
      visit(childAddress(address, 1, 0));
      visit(childAddress(address, 0, 1));
      visit(childAddress(address, 1, 1));
      return;
    }
    selected.push(address);
  };
  for (const root of ROOT_NODES) visit(root);
  const ordered = selected.sort(compareNodeAddress);
  return options.maxLivePatches === undefined
    ? ordered
    : capTerrainNodes(ordered, cameraPosition, options.maxLivePatches, planetRadiusM);
}

function isDescendantOrSelf(candidate: TerrainNodeAddress, ancestor: TerrainNodeAddress): boolean {
  if (candidate.face !== ancestor.face || candidate.level < ancestor.level) return false;
  const shift = candidate.level - ancestor.level;
  return (candidate.x >> shift) === ancestor.x && (candidate.y >> shift) === ancestor.y;
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
): readonly TerrainNodeAddress[] {
  const desiredNodes = [...desired];
  const next: TerrainNodeAddress[] = [];
  for (const node of displayed) {
    const children = [
      childAddress(node, 0, 0),
      childAddress(node, 1, 0),
      childAddress(node, 0, 1),
      childAddress(node, 1, 1),
    ];
    const canSwap = children.every((child) => ready.has(nodeAddressKey(child)))
      && children.some((child) => desiredNodes.some((candidate) => isDescendantOrSelf(candidate, child)));
    if (canSwap) next.push(...children);
    else next.push(node);
  }
  return next.sort(compareNodeAddress);
}

/** Merge a complete displayed sibling quartet only when the parent is wanted. */
export function mergeCompleteSiblings(
  displayed: readonly TerrainNodeAddress[],
  desired: readonly TerrainNodeAddress[],
  ready: ReadonlySet<string>,
): readonly TerrainNodeAddress[] {
  const displayedKeys = new Set(displayed.map(nodeAddressKey));
  const desiredKeys = new Set(desired.map(nodeAddressKey));
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
    const canMerge = desiredKeys.has(nodeAddressKey(parent))
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

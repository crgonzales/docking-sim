import {
  childAddress,
  decideLod,
  nodeAddressKey,
  nodeAngularRadiusRadians,
  nodeCenterDirection,
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
  return nodes.map((node, index) => ({
    node,
    index,
    distance: distanceSquared(cameraPosition, nodeCenterPosition(node, planetRadiusM)),
  })).sort((a, b) => a.distance - b.distance
    || nodeAddressKey(a.node).localeCompare(nodeAddressKey(b.node))
    || a.index - b.index).slice(0, maxLivePatches).map(({ node }) => node);
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
  const ordered = selected.sort((a, b) => nodeAddressKey(a).localeCompare(nodeAddressKey(b)));
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
 * Replace a displayed parent only when all four direct children have both a
 * desired descendant and a completed patch. This is the no-hole swap oracle.
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
    const canSwap = children.every((child) => ready.has(nodeAddressKey(child))
      && desiredNodes.some((candidate) => isDescendantOrSelf(candidate, child)));
    if (canSwap) next.push(...children);
    else next.push(node);
  }
  return next.sort((a, b) => nodeAddressKey(a).localeCompare(nodeAddressKey(b)));
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
  return next.sort((a, b) => nodeAddressKey(a).localeCompare(nodeAddressKey(b)));
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

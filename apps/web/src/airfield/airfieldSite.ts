import type { Vec3 } from '@docking/sim-core';
import { flightWorldFrame } from '../flight/flightFrame';
import {
  EARTH_CENTER_DISTANCE_M,
  EARTH_RADIUS_M,
} from '../scene/sky/skyConfig';

/** Survey: continuous terrain bound 103.124525 m, clipped mesh peak 97.861428 m.
 * Evidence: .evidence.local/airfield-terrain-survey.json (full footprint, LOD 0–16). */
export const AIRFIELD_DATUM_ALTITUDE_M = 105;
export const AIRFIELD_FOUNDATION_DEPTH_M = 35;
export const AIRFIELD_SPAWN_YAW_RAD = -Math.PI / 2;
export const AIRFIELD_MAX_WALK_DISTANCE_M = 1000;
export const AIRFIELD_CHARACTER_RADIUS_M = 0.35;
export const AIRFIELD_PERIMETER_WIDTH_M = 0.2;
const PERIMETER_CLEARANCE_M = AIRFIELD_CHARACTER_RADIUS_M + AIRFIELD_PERIMETER_WIDTH_M;

const AIRFIELD_LATITUDE_RAD = 7 * Math.PI / 180;
const AIRFIELD_LONGITUDE_RAD = 0.02 * Math.PI / 180;

/** NED chart position of the tangent-plane datum, including its altitude. */
export const AIRFIELD_ANCHOR_N_M: Vec3 = [
  AIRFIELD_LATITUDE_RAD * EARTH_RADIUS_M,
  AIRFIELD_LONGITUDE_RAD * EARTH_RADIUS_M,
  -AIRFIELD_DATUM_ALTITUDE_M,
];

export interface AirfieldBasis {
  /** Site-local +x, in the renderer's world frame. */
  readonly east: Vec3;
  /** Site-local +y, radial up at the datum. */
  readonly up: Vec3;
  /** Site-local +z, toward geographic south. */
  readonly south: Vec3;
}

export interface AirfieldBounds {
  readonly eastMinM: number;
  readonly eastMaxM: number;
  readonly northMinM: number;
  readonly northMaxM: number;
}

export interface AirfieldBuildingFootprint {
  readonly id: string;
  readonly kind: 'HANGAR' | 'TOWER';
  readonly centerEastM: number;
  /** Local south coordinate; negative values are north of the datum. */
  readonly centerSouthM: number;
  readonly widthM: number;
  readonly lengthM: number;
  readonly eastMinM: number;
  readonly eastMaxM: number;
  readonly southMinM: number;
  readonly southMaxM: number;
}

export interface AirfieldStructure {
  readonly id: string;
  readonly kind: AirfieldBuildingFootprint['kind'];
  readonly footprint: AirfieldBuildingFootprint;
  readonly heightM: number;
  readonly roofHeightM?: number;
}

export interface AirfieldSurface {
  readonly id: string;
  readonly kind: 'RUNWAY' | 'SHOULDER' | 'TAXIWAY' | 'CONNECTOR' | 'APRON' | 'PAD';
  readonly centerEastM: number;
  readonly centerSouthM: number;
  readonly widthM: number;
  readonly lengthM: number;
}

export interface AirfieldSiteDefinition {
  readonly datum: {
    readonly altitudeM: number;
    readonly anchor_N_m: Vec3;
    readonly worldPosition: readonly [number, number, number];
  };
  readonly basis: AirfieldBasis;
  readonly dimensions: {
    readonly baseWidthM: number;
    readonly baseLengthM: number;
    readonly runwayLengthM: number;
    readonly runwayWidthM: number;
    readonly taxiwayWidthM: number;
    readonly thresholdBars: number;
    readonly northDesignation: string;
    readonly southDesignation: string;
  };
  readonly bounds: AirfieldBounds;
  readonly surfaces: readonly AirfieldSurface[];
  readonly structures: readonly AirfieldStructure[];
}

const frameAtDatum = flightWorldFrame(AIRFIELD_ANCHOR_N_M);
const EARTH_CENTER_WORLD: readonly [number, number, number] = [
  -EARTH_CENTER_DISTANCE_M,
  0,
  0,
];

function add(first: readonly [number, number, number], second: readonly [number, number, number]): readonly [number, number, number] {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

function dot(first: readonly [number, number, number], second: readonly [number, number, number]): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function subtract(first: readonly [number, number, number], second: readonly [number, number, number]): readonly [number, number, number] {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function scale(value: readonly [number, number, number], amount: number): readonly [number, number, number] {
  return [value[0] * amount, value[1] * amount, value[2] * amount];
}

const datumWorld = frameAtDatum.position as readonly [number, number, number];
const datumEarthCentered = subtract(datumWorld, EARTH_CENTER_WORLD);
const north = frameAtDatum.direction([1, 0, 0]);

/** Shared site tangent basis. The columns are local east, up, and south. */
export const AIRFIELD_BASIS: AirfieldBasis = {
  east: frameAtDatum.direction([0, 1, 0]),
  up: [...frameAtDatum.up],
  south: [-north[0], -north[1], -north[2]],
};

/** World-space datum position before conversion to a camera-relative frame. */
export const AIRFIELD_DATUM_WORLD: readonly [number, number, number] = datumWorld;

export const AIRFIELD_BOUNDS: AirfieldBounds = {
  eastMinM: -450,
  eastMaxM: 100,
  northMinM: -850,
  northMaxM: 850,
};

export const AIRFIELD_RUNWAY_LENGTH_M = 1600;
export const AIRFIELD_RUNWAY_WIDTH_M = 50;
export const AIRFIELD_PAVEMENT_TOP_Y_M = 0;
export const AIRFIELD_MARKING_OFFSET_M = 0.005;

export const AIRFIELD_RUNWAY_NORTH_THRESHOLD_LOCAL: Vec3 = [
  0,
  AIRFIELD_PAVEMENT_TOP_Y_M,
  -AIRFIELD_RUNWAY_LENGTH_M / 2,
];
export const AIRFIELD_RUNWAY_SOUTH_THRESHOLD_LOCAL: Vec3 = [
  0,
  AIRFIELD_PAVEMENT_TOP_Y_M,
  AIRFIELD_RUNWAY_LENGTH_M / 2,
];

const SURFACES: readonly AirfieldSurface[] = [
  { id: 'runway', kind: 'RUNWAY', centerEastM: 0, centerSouthM: 0, widthM: AIRFIELD_RUNWAY_WIDTH_M, lengthM: AIRFIELD_RUNWAY_LENGTH_M },
  { id: 'shoulder-west', kind: 'SHOULDER', centerEastM: -30.5, centerSouthM: 0, widthM: 11, lengthM: 1600 },
  { id: 'shoulder-east', kind: 'SHOULDER', centerEastM: 30.5, centerSouthM: 0, widthM: 11, lengthM: 1600 },
  { id: 'taxiway-west', kind: 'TAXIWAY', centerEastM: -75, centerSouthM: 0, widthM: 14, lengthM: 1600 },
  { id: 'taxi-connector-north', kind: 'CONNECTOR', centerEastM: -50, centerSouthM: -700, widthM: 50, lengthM: 18 },
  { id: 'taxi-connector-mid-north', kind: 'CONNECTOR', centerEastM: -50, centerSouthM: -350, widthM: 50, lengthM: 18 },
  { id: 'taxi-connector-mid-south', kind: 'CONNECTOR', centerEastM: -50, centerSouthM: 350, widthM: 50, lengthM: 18 },
  { id: 'taxi-connector-south', kind: 'CONNECTOR', centerEastM: -50, centerSouthM: 700, widthM: 50, lengthM: 18 },
  // Aprons share an edge at south=40 and meet the taxiway at east=-82.
  { id: 'apron-north', kind: 'APRON', centerEastM: -177, centerSouthM: -190, widthM: 190, lengthM: 460 },
  { id: 'apron-south', kind: 'APRON', centerEastM: -177, centerSouthM: 175, widthM: 190, lengthM: 270 },
  { id: 'pad-link', kind: 'CONNECTOR', centerEastM: -281, centerSouthM: 280, widthM: 18, lengthM: 18 },
  { id: 'pad', kind: 'PAD', centerEastM: -340, centerSouthM: 300, widthM: 100, lengthM: 120 },
];

function footprint(
  id: string,
  kind: AirfieldBuildingFootprint['kind'],
  centerEastM: number,
  centerSouthM: number,
  widthM: number,
  lengthM: number,
): AirfieldBuildingFootprint {
  return {
    id,
    kind,
    centerEastM,
    centerSouthM,
    widthM,
    lengthM,
    eastMinM: centerEastM - widthM / 2,
    eastMaxM: centerEastM + widthM / 2,
    southMinM: centerSouthM - lengthM / 2,
    southMaxM: centerSouthM + lengthM / 2,
  };
}

/** Solid collision footprints. Decorative doors and roof trim do not enlarge these. */
export const AIRFIELD_BUILDING_FOOTPRINTS: readonly AirfieldBuildingFootprint[] = [
  footprint('hangar-alpha', 'HANGAR', -180, -330, 130, 120),
  footprint('hangar-bravo', 'HANGAR', -180, -165, 130, 120),
  footprint('hangar-charlie', 'HANGAR', -180, 0, 130, 120),
  footprint('tower', 'TOWER', -180, 82, 42, 42),
];

const STRUCTURES: readonly AirfieldStructure[] = [
  { id: 'hangar-alpha', kind: 'HANGAR', footprint: AIRFIELD_BUILDING_FOOTPRINTS[0], heightM: 14, roofHeightM: 18 },
  { id: 'hangar-bravo', kind: 'HANGAR', footprint: AIRFIELD_BUILDING_FOOTPRINTS[1], heightM: 14, roofHeightM: 18 },
  { id: 'hangar-charlie', kind: 'HANGAR', footprint: AIRFIELD_BUILDING_FOOTPRINTS[2], heightM: 14, roofHeightM: 18 },
  { id: 'tower', kind: 'TOWER', footprint: AIRFIELD_BUILDING_FOOTPRINTS[3], heightM: 29 },
];

export const AIRFIELD_SITE: AirfieldSiteDefinition = {
  datum: {
    altitudeM: AIRFIELD_DATUM_ALTITUDE_M,
    anchor_N_m: AIRFIELD_ANCHOR_N_M,
    worldPosition: AIRFIELD_DATUM_WORLD,
  },
  basis: AIRFIELD_BASIS,
  dimensions: {
    baseWidthM: AIRFIELD_BOUNDS.eastMaxM - AIRFIELD_BOUNDS.eastMinM,
    baseLengthM: AIRFIELD_BOUNDS.northMaxM - AIRFIELD_BOUNDS.northMinM,
    runwayLengthM: AIRFIELD_RUNWAY_LENGTH_M,
    runwayWidthM: AIRFIELD_RUNWAY_WIDTH_M,
    taxiwayWidthM: 14,
    thresholdBars: 12,
    northDesignation: '18',
    southDesignation: '36',
  },
  bounds: AIRFIELD_BOUNDS,
  surfaces: SURFACES,
  structures: STRUCTURES,
};

function ensureFiniteVector(position: Vec3, name: string): void {
  if (!position.every(Number.isFinite)) throw new RangeError(`${name} must be finite`);
}

function worldFromChart(position_N_m: Vec3): readonly [number, number, number] {
  return flightWorldFrame(position_N_m).position as readonly [number, number, number];
}

function pointInSolidFootprint(eastM: number, southM: number): boolean {
  return AIRFIELD_BUILDING_FOOTPRINTS.some((building) => {
    const closestEast = Math.max(building.eastMinM, Math.min(eastM, building.eastMaxM));
    const closestSouth = Math.max(building.southMinM, Math.min(southM, building.southMaxM));
    return Math.hypot(eastM - closestEast, southM - closestSouth) <= AIRFIELD_CHARACTER_RADIUS_M;
  });
}

/**
 * Intersect the query's radial ray with the tangent plane. The query height is
 * intentionally absent from the result: only its direction selects a point
 * on the plane, so callers can correct an arbitrary-height query immediately.
 */
export function airfieldGroundHeight(position_N_m: Vec3): number | null {
  if (!position_N_m.every(Number.isFinite)) return null;
  const queryUp = flightWorldFrame(position_N_m).up;
  const planeRadius = EARTH_RADIUS_M + AIRFIELD_DATUM_ALTITUDE_M;
  const projection = dot(queryUp, AIRFIELD_BASIS.up);
  // A non-positive projection points at the far side of the Earth and has no
  // useful tangent-plane intersection for this bounded local site.
  if (!Number.isFinite(projection) || projection <= 0) return null;
  const intersectionRadius = planeRadius / projection;
  if (!Number.isFinite(intersectionRadius) || intersectionRadius <= 0) return null;
  const intersection = scale(queryUp, intersectionRadius);
  const localOffset = subtract(intersection, datumEarthCentered);
  const eastM = dot(localOffset, AIRFIELD_BASIS.east);
  const southM = dot(localOffset, AIRFIELD_BASIS.south);
  if (!Number.isFinite(eastM) || !Number.isFinite(southM)
    || eastM < AIRFIELD_BOUNDS.eastMinM + PERIMETER_CLEARANCE_M
    || eastM > AIRFIELD_BOUNDS.eastMaxM - PERIMETER_CLEARANCE_M
    || southM < -AIRFIELD_BOUNDS.northMaxM + PERIMETER_CLEARANCE_M
    || southM > -AIRFIELD_BOUNDS.northMinM - PERIMETER_CLEARANCE_M
    || pointInSolidFootprint(eastM, southM)) return null;
  return intersectionRadius - EARTH_RADIUS_M;
}

/** Project the actual query point, including its radial height, into site axes. */
export function airfieldLocalPoint(position_N_m: Vec3): Vec3 {
  ensureFiniteVector(position_N_m, 'Airfield chart position');
  const offset = subtract(worldFromChart(position_N_m), datumWorld);
  return [
    dot(offset, AIRFIELD_BASIS.east),
    dot(offset, AIRFIELD_BASIS.up),
    dot(offset, AIRFIELD_BASIS.south),
  ];
}

/**
 * Inverse of airfieldLocalPoint. The tangent-local point is first made an
 * Earth-centered Cartesian point; atan2 then restores the flight chart's
 * latitude/longitude signs and the radial length restores MSL altitude.
 */
export function airfieldPositionFromLocal(local: Vec3): Vec3 {
  ensureFiniteVector(local, 'Airfield local point');
  const localEarthOffset = add(
    scale(AIRFIELD_BASIS.east, local[0]),
    add(scale(AIRFIELD_BASIS.up, local[1]), scale(AIRFIELD_BASIS.south, local[2])),
  );
  const earthCentered = add(datumEarthCentered, localEarthOffset);
  const radius = Math.hypot(earthCentered[0], earthCentered[1], earthCentered[2]);
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Airfield local point produces an invalid Earth radius');
  const latitude = Math.atan2(earthCentered[1], Math.hypot(earthCentered[0], earthCentered[2]));
  const longitude = Math.atan2(-earthCentered[2], earthCentered[0]);
  return [latitude * EARTH_RADIUS_M, longitude * EARTH_RADIUS_M, EARTH_RADIUS_M - radius];
}

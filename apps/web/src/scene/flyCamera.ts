export type FlyVector3 = readonly [number, number, number];
export type FlyInput = readonly [number, number, number];

export interface FlyBasis {
  readonly north: FlyVector3;
  readonly east: FlyVector3;
  readonly up: FlyVector3;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function length(vector: FlyVector3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function dot(a: FlyVector3, b: FlyVector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: FlyVector3, b: FlyVector3): FlyVector3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(vector: FlyVector3): FlyVector3 {
  const size = length(vector);
  if (!Number.isFinite(size) || size === 0) throw new Error('Fly basis vectors must be finite and non-zero');
  return [vector[0] / size, vector[1] / size, vector[2] / size];
}

function basisFromUp(up: FlyVector3): FlyBasis {
  const normalizedUp = normalize(up);
  // World +Y is the geodetic north reference away from the poles. At a pole,
  // use +Z solely to choose a stable tangent meridian.
  const reference: FlyVector3 = Math.abs(normalizedUp[1]) < 0.99 ? [0, 1, 0] : [0, 0, 1];
  const east = normalize(cross(reference, normalizedUp));
  const north = normalize(cross(normalizedUp, east));
  return { north, east, up: normalizedUp };
}

/** Build the local north/east/up frame at an absolute world position. */
export function flyBasisFromPosition(
  position: FlyVector3,
  earthCenter: FlyVector3 = [0, 0, 0],
): FlyBasis {
  return basisFromUp([
    position[0] - earthCenter[0],
    position[1] - earthCenter[1],
    position[2] - earthCenter[2],
  ]);
}

/** Camera-forward direction for a zero-roll pose in the supplied local frame. */
export function flyForward(
  yawRad: number,
  pitchRad: number,
  up: FlyVector3 = [0, 0, 1],
): FlyVector3 {
  const basis = basisFromUp(up);
  const cosine = Math.cos(pitchRad);
  return [
    basis.north[0] * cosine * Math.cos(yawRad) + basis.east[0] * cosine * Math.sin(yawRad) + basis.up[0] * Math.sin(pitchRad),
    basis.north[1] * cosine * Math.cos(yawRad) + basis.east[1] * cosine * Math.sin(yawRad) + basis.up[1] * Math.sin(pitchRad),
    basis.north[2] * cosine * Math.cos(yawRad) + basis.east[2] * cosine * Math.sin(yawRad) + basis.up[2] * Math.sin(pitchRad),
  ];
}

/** Camera-right direction for a zero-roll pose in the supplied local frame. */
export function flyRight(yawRad: number, up: FlyVector3 = [0, 0, 1]): FlyVector3 {
  const basis = basisFromUp(up);
  return [
    basis.east[0] * Math.cos(yawRad) - basis.north[0] * Math.sin(yawRad),
    basis.east[1] * Math.cos(yawRad) - basis.north[1] * Math.sin(yawRad),
    basis.east[2] * Math.cos(yawRad) - basis.north[2] * Math.sin(yawRad),
  ];
}

export function flyPoseFromDirection(
  direction: FlyVector3,
  up: FlyVector3 = [0, 0, 1],
): { yawRad: number; pitchRad: number } {
  const size = length(direction);
  if (!Number.isFinite(size) || size === 0) return { yawRad: 0, pitchRad: 0 };
  const normalized = [direction[0] / size, direction[1] / size, direction[2] / size] as const;
  const basis = basisFromUp(up);
  const pitch = Math.asin(clamp(dot(normalized, basis.up), -1, 1));
  return {
    yawRad: Math.atan2(dot(normalized, basis.east), dot(normalized, basis.north)),
    pitchRad: clamp(pitch, -1.5, 1.5),
  };
}

/** Integrate one local-input flight step without changing the caller's pose. */
export function stepFlyPosition(
  position: FlyVector3,
  input: FlyInput,
  yawRad: number,
  pitchRad: number,
  speedMps: number,
  deltaSeconds: number,
  earthCenter: FlyVector3 = [0, 0, 0],
): FlyVector3 {
  if (!Number.isFinite(speedMps) || speedMps < 0) throw new Error('Fly speed must be non-negative and finite');
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new Error('Fly delta must be non-negative and finite');
  const basis = flyBasisFromPosition(position, earthCenter);
  const forward = flyForward(yawRad, pitchRad, basis.up);
  const right = flyRight(yawRad, basis.up);
  const movement: FlyVector3 = [
    right[0] * input[0] + forward[0] * input[1] + basis.up[0] * input[2],
    right[1] * input[0] + forward[1] * input[1] + basis.up[1] * input[2],
    right[2] * input[0] + forward[2] * input[1] + basis.up[2] * input[2],
  ];
  const movementLength = length(movement);
  if (movementLength === 0) return position;
  const scale = speedMps * deltaSeconds / Math.max(movementLength, 1);
  return [
    position[0] + movement[0] * scale,
    position[1] + movement[1] * scale,
    position[2] + movement[2] * scale,
  ];
}

/** Keep the camera above the sampled terrain or sea-level surface. */
export function clampFlyPositionToGround(
  position: FlyVector3,
  planetRadiusM: number,
  groundHeightM: number,
  clearanceM: number,
): FlyVector3 {
  if (!Number.isFinite(planetRadiusM) || planetRadiusM <= 0) throw new Error('Planet radius must be positive');
  if (!Number.isFinite(groundHeightM) || !Number.isFinite(clearanceM) || clearanceM < 0) {
    throw new Error('Ground height and clearance must be finite');
  }
  const radius = length(position);
  const floorRadius = planetRadiusM + Math.max(groundHeightM, 0) + clearanceM;
  if (radius >= floorRadius || radius === 0) return position;
  const scale = floorRadius / radius;
  return [position[0] * scale, position[1] * scale, position[2] * scale];
}

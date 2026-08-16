export type ModelVec3 = readonly [number, number, number];
export type ModelEulerXYZ = readonly [number, number, number];

type SourcePort =
  | { portLocal: ModelVec3; portNodeName?: never }
  | { portNodeName: string; portLocal?: never };

export type ModelNormalization = SourcePort & {
  /** Uniform source-space-to-render-space scale. */
  scale: number;
  /** Euler XYZ rotation, in radians, applied after scale. */
  rotation: ModelEulerXYZ;
  /** Render-space translation from the source origin to the sim body frame. */
  pivotOffset: ModelVec3;
  /** Fixed port offset required by the sim contact geometry. */
  portAnchor: ModelVec3;
};

export interface NormalizedModelTransform {
  scale: number;
  rotation: ModelEulerXYZ;
  position: ModelVec3;
  portPosition: ModelVec3;
  portAnchor: ModelVec3;
  portError: ModelVec3;
}

/** Fixed contact anchors mirrored from sim-core's docking geometry. */
export const STATION_PORT_HILL: ModelVec3 = [0, -8.7, 0];
export const CHASER_PORT_BODY: ModelVec3 = [0, 1.7, 0];

/**
 * NASA ESAS Crew Module: source bbox width 166.337 m, Z length 86.049 m.
 * The scale follows the 1.28 m thruster ring radius; the short real capsule
 * cannot match the primitive's 3.4 m length at the same scale.
 */
const CHASER_SOURCE_HALF_WIDTH_M = 83.1683273315;
const CHASER_SOURCE_PORT_LOCAL: ModelVec3 = [0, 0, 23.9964008331];
const CHASER_GLTF_SCALE = 1.28 / CHASER_SOURCE_HALF_WIDTH_M;
export const CHASER_MODEL_NORMALIZATION: ModelNormalization = {
  scale: CHASER_GLTF_SCALE,
  // Source +Z symmetry axis -> sim +ŷ docking axis.
  rotation: [-Math.PI / 2, 0, 0],
  pivotOffset: [
    0,
    CHASER_PORT_BODY[1] - CHASER_SOURCE_PORT_LOCAL[2] * CHASER_GLTF_SCALE,
    0,
  ],
  portLocal: CHASER_SOURCE_PORT_LOCAL,
  portAnchor: CHASER_PORT_BODY,
};

/** Target ISS variant: declared lower-y docking face from its source bbox. */
const TARGET_SOURCE_PORT_LOCAL: ModelVec3 = [0, -4.1685137749, 0];
const TARGET_GLTF_SCALE = 0.5;
export const TARGET_MODEL_NORMALIZATION: ModelNormalization = {
  scale: TARGET_GLTF_SCALE,
  rotation: [0, 0, 0],
  pivotOffset: [
    0,
    STATION_PORT_HILL[1] - TARGET_SOURCE_PORT_LOCAL[1] * TARGET_GLTF_SCALE,
    0,
  ],
  portLocal: TARGET_SOURCE_PORT_LOCAL,
  portAnchor: STATION_PORT_HILL,
};

function rotateX([x, y, z]: ModelVec3, angle: number): ModelVec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x, c * y - s * z, s * y + c * z];
}

function rotateY([x, y, z]: ModelVec3, angle: number): ModelVec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * x + s * z, y, -s * x + c * z];
}

function rotateZ([x, y, z]: ModelVec3, angle: number): ModelVec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * x - s * y, s * x + c * y, z];
}

function rotateEulerXYZ(point: ModelVec3, rotation: ModelEulerXYZ): ModelVec3 {
  return rotateZ(rotateY(rotateX(point, rotation[0]), rotation[1]), rotation[2]);
}

/**
 * Compute the post-transform port position from a declared source-space
 * datum. This is intentionally pure: model registration can be checked
 * without loading React, Three.js, or a browser renderer.
 *
 * `pivotOffset` is expressed in render metres after scale/rotation. This
 * makes the registration equation explicit:
 *
 *   portAnchor = rotate(rotation, portLocal * scale) + pivotOffset
 */
export function computeModelNormalizationTransform(
  normalization: ModelNormalization,
  resolvedPortLocal?: ModelVec3,
): NormalizedModelTransform {
  const portLocal = normalization.portLocal ?? resolvedPortLocal;
  if (portLocal === undefined) {
    throw new Error(
      `Model port node "${normalization.portNodeName}" must be resolved before normalization`,
    );
  }

  const scaledPort: ModelVec3 = [
    portLocal[0] * normalization.scale,
    portLocal[1] * normalization.scale,
    portLocal[2] * normalization.scale,
  ];
  const rotatedPort = rotateEulerXYZ(scaledPort, normalization.rotation);
  const portPosition: ModelVec3 = [
    rotatedPort[0] + normalization.pivotOffset[0],
    rotatedPort[1] + normalization.pivotOffset[1],
    rotatedPort[2] + normalization.pivotOffset[2],
  ];

  return {
    scale: normalization.scale,
    rotation: normalization.rotation,
    position: normalization.pivotOffset,
    portPosition,
    portAnchor: normalization.portAnchor,
    portError: [
      portPosition[0] - normalization.portAnchor[0],
      portPosition[1] - normalization.portAnchor[1],
      portPosition[2] - normalization.portAnchor[2],
    ],
  };
}

export function maxAbsComponent(vector: ModelVec3): number {
  return Math.max(Math.abs(vector[0]), Math.abs(vector[1]), Math.abs(vector[2]));
}

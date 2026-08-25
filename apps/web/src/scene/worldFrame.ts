import {
  SKY_CONFIG,
  WORLD_FRAME_REBASE_THRESHOLD_M,
} from './sky/skyConfig';

/** CPU-side world coordinates in metres. JavaScript numbers provide f64 storage. */
export type WorldPositionF64 = readonly [number, number, number];

/** Render coordinates are still f64 until the renderer uploads them to the GPU. */
export type RenderPosition = readonly [number, number, number];

export interface WorldFrameOptions {
  /** Number of metres represented by one render unit. */
  metersPerUnit?: number;
  /** Distance in metres at which an automatic rebase is triggered. */
  rebaseThresholdM?: number;
}

const ZERO_POSITION: WorldPositionF64 = [0, 0, 0];

function copyPosition(position: WorldPositionF64): WorldPositionF64 {
  return [position[0], position[1], position[2]];
}

/** Subtract two world positions without converting through a lower-precision type. */
export function subtractF64(
  minuend: WorldPositionF64,
  subtrahend: WorldPositionF64,
): WorldPositionF64 {
  return [
    minuend[0] - subtrahend[0],
    minuend[1] - subtrahend[1],
    minuend[2] - subtrahend[2],
  ];
}

export function distanceSquaredF64(
  first: WorldPositionF64,
  second: WorldPositionF64,
): number {
  const delta = subtractF64(first, second);
  return delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2;
}

export function distanceF64(
  first: WorldPositionF64,
  second: WorldPositionF64,
): number {
  return Math.sqrt(distanceSquaredF64(first, second));
}

/** Return whether the camera has moved far enough from the current render anchor. */
export function shouldRebase(
  cameraPosition: WorldPositionF64,
  anchor: WorldPositionF64,
  thresholdM = WORLD_FRAME_REBASE_THRESHOLD_M,
): boolean {
  return distanceSquaredF64(cameraPosition, anchor) > thresholdM ** 2;
}

/** Snap the anchor to the camera only when the configured rebase distance is exceeded. */
export function rebaseAnchor(
  anchor: WorldPositionF64,
  cameraPosition: WorldPositionF64,
  thresholdM = WORLD_FRAME_REBASE_THRESHOLD_M,
): WorldPositionF64 {
  return shouldRebase(cameraPosition, anchor, thresholdM)
    ? copyPosition(cameraPosition)
    : copyPosition(anchor);
}

/**
 * Convert an absolute metre position to render coordinates. The anchor
 * subtraction intentionally happens before the metres-to-render-units scale
 * and before the renderer's eventual f32 upload.
 */
export function toRender(
  position: WorldPositionF64,
  anchor: WorldPositionF64,
  metersPerUnit = SKY_CONFIG.renderScaleMPerUnit,
): RenderPosition {
  const relative = subtractF64(position, anchor);
  return [
    relative[0] / metersPerUnit,
    relative[1] / metersPerUnit,
    relative[2] / metersPerUnit,
  ];
}

/** Convert a render-space position back to its absolute metre coordinates. */
export function toWorld(
  position: RenderPosition,
  anchor: WorldPositionF64,
  metersPerUnit = SKY_CONFIG.renderScaleMPerUnit,
): WorldPositionF64 {
  return [
    anchor[0] + position[0] * metersPerUnit,
    anchor[1] + position[1] * metersPerUnit,
    anchor[2] + position[2] * metersPerUnit,
  ];
}

/**
 * Convert an anchor-independent separation to render units. Keeping the
 * subtraction in f64 makes the relative-position oracle explicit and gives
 * callers a stable value to compare across a render-origin rebase.
 */
export function relativeToRender(
  first: WorldPositionF64,
  second: WorldPositionF64,
  metersPerUnit = SKY_CONFIG.renderScaleMPerUnit,
): RenderPosition {
  const relative = subtractF64(first, second);
  return [
    relative[0] / metersPerUnit,
    relative[1] / metersPerUnit,
    relative[2] / metersPerUnit,
  ];
}

export class WorldFrame {
  private anchorPosition: WorldPositionF64;
  private readonly metersPerUnit: number;
  private readonly rebaseThresholdM: number;

  constructor(
    initialAnchor: WorldPositionF64 = ZERO_POSITION,
    options: WorldFrameOptions = {},
  ) {
    this.anchorPosition = copyPosition(initialAnchor);
    this.metersPerUnit = options.metersPerUnit ?? SKY_CONFIG.renderScaleMPerUnit;
    this.rebaseThresholdM = options.rebaseThresholdM ?? WORLD_FRAME_REBASE_THRESHOLD_M;
  }

  get anchor(): WorldPositionF64 {
    return copyPosition(this.anchorPosition);
  }

  get thresholdM(): number {
    return this.rebaseThresholdM;
  }

  setAnchor(anchor: WorldPositionF64): void {
    this.anchorPosition = copyPosition(anchor);
  }

  toRender(position: WorldPositionF64): RenderPosition {
    return toRender(position, this.anchorPosition, this.metersPerUnit);
  }

  toWorld(position: RenderPosition): WorldPositionF64 {
    return toWorld(position, this.anchorPosition, this.metersPerUnit);
  }

  relativeToRender(
    first: WorldPositionF64,
    second: WorldPositionF64,
  ): RenderPosition {
    return relativeToRender(first, second, this.metersPerUnit);
  }

  /** Rebase once the camera is beyond the threshold; return true when it moved. */
  rebase(cameraPosition: WorldPositionF64): boolean {
    if (!shouldRebase(cameraPosition, this.anchorPosition, this.rebaseThresholdM)) {
      return false;
    }
    this.anchorPosition = copyPosition(cameraPosition);
    return true;
  }
}

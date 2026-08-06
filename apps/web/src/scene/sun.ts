import { Vector3 } from 'three';

/**
 * Single authority for the sun direction (Hill-frame, unit vector).
 * Both the directional light and the Earth terminator shader consume this,
 * so lighting and the day/night boundary can never disagree.
 *
 * Chosen so the camera's default framing sees a dramatic terminator:
 * sun mostly along +y (along-track) with a radial-out tilt.
 */
export const SUN_DIR = new Vector3(0.35, 0.85, 0.15).normalize();

/** Distance at which the visual directional light sits (meters, scene units). */
export const SUN_LIGHT_DISTANCE_M = 5_000;

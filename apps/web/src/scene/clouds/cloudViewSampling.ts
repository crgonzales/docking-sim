/** Primary-ray quality preferences; the marcher may exceed the step cap to
 * cover a long grazing ray within the fixed iteration budget. Nearby cloud
 * edges need closer samples than the old 800 m empty-space acceleration cap. */
export const CLOUD_VIEW_SAMPLING = Object.freeze({
  low: Object.freeze({ maxIterationCount: 128, minStepSize: 80, maxStepSize: 320, perspectiveStepScale: 1.04 }),
  medium: Object.freeze({ maxIterationCount: 192, minStepSize: 80, maxStepSize: 160, perspectiveStepScale: 1.04 }),
});

// Preserve the stationary resolve's existing quadrature allowance: grazing
// rays can exceed the preferred sampling caps when their budget runs low.
export const CLOUD_STATIONARY_DEPTH_UNCERTAINTY_M = 800;

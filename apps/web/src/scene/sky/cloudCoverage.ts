import {
  cloudCoverageAtCpu,
  CLOUD_COVERAGE_DETAIL_MODULATION,
  CLOUD_COVERAGE_DETAIL_OFFSET,
  CLOUD_COVERAGE_REMAP_CENTER,
  CLOUD_COVERAGE_SMOOTH_MAX,
  CLOUD_COVERAGE_SMOOTH_MIN,
} from './skyConfig';

/** Shared cloud coverage GLSL and its CPU mirror. */
export const CLOUD_COVERAGE_GLSL = /* glsl */ `
  float cloudCoverageAt(
    sampler2D cloudMap,
    vec2 uv,
    float detailScale,
    float detailStrength,
    float contrast
  ) {
    float base = texture2D(cloudMap, uv).r;
    float detail = texture2D(cloudMap, uv * detailScale + vec2(${CLOUD_COVERAGE_DETAIL_OFFSET[0].toFixed(2)}, ${CLOUD_COVERAGE_DETAIL_OFFSET[1].toFixed(2)})).r;
    float coverage = base * (1.0 - detailStrength * ${CLOUD_COVERAGE_DETAIL_MODULATION.toFixed(2)} * (1.0 - detail));
    coverage = clamp((coverage - ${CLOUD_COVERAGE_REMAP_CENTER.toFixed(2)}) * contrast + ${CLOUD_COVERAGE_REMAP_CENTER.toFixed(2)}, 0.0, 1.0);
    return smoothstep(${CLOUD_COVERAGE_SMOOTH_MIN.toFixed(2)}, ${CLOUD_COVERAGE_SMOOTH_MAX.toFixed(2)}, coverage);
  }
`;

export { cloudCoverageAtCpu };

export {
  CLOUD_DECK_CONTRAST,
  CLOUD_DECK_DETAIL_SCALE,
  CLOUD_DECK_DETAIL_STRENGTH,
} from './skyConfig';

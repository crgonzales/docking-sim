import type { CloudsEffect } from '@takram/three-clouds';

/** Pinned @takram/three-clouds 0.7.6 / three-atmosphere 0.19.1 storage ABI.
 * RGBA = front distance in km, extinction per km, optical depth / 1000,
 * tail optical depth / 1000. All four transforms are linear: decoding after
 * bilinear/history filtering preserves the original optical-depth model; PCF
 * then averages the decoded optical depths as before.
 * In particular, neither optical depth nor distance is clamped/log encoded.
 *
 * RGBA16F envelope: |front| <= 65,504,000 m, extinction <= 65.504 / m,
 * each optical-depth channel <= 65,504,000. This includes the pinned 1e6 m
 * miss sentinel and terrestrial grazing rays. B/A are NOT inherently small:
 * densitySum <= 4, E <= 4(scattering + absorption), and structured sampling
 * has step <= sqrt(5) * maxStepSize (icosahedron face vertices have pairwise
 * dot >= 1/sqrt(5)). Thus B <= iterations * E * step, A <= step / 2.
 * Stock presets fit comfortably; custom coefficients/steps must fit this ABI.
 */
export const CLOUD_SHADOW_STORAGE = Object.freeze({
  distanceScale: 1e-3,
  extinctionScale: 1e3,
  opticalDepthScale: 1e-3,
  motionDepthScale: 1e-4,
  halfFloatMax: 65504,
});

const ERROR = 'Pinned Takram shadow storage shader changed; review precision adapter';
const ENCODE = 'vec4(1e-3, 1e3, 1e-3, 1e-3)';
const DECODE = 'vec4(1e3, 1e-3, 1e3, 1e3)';
const READ = '  vec4 shadow = texture(shadowBuffer, vec3(uv, float(cascadeIndex)));';
const DECODED_READ = `${READ}\n  shadow *= ${DECODE}; // Restore physical shadow units after filtering.`;

type Edit = readonly [before: string, after: string];

// Every seam must be unique in the ORIGINAL source. Prepare all shaders before
// assigning any material, so a late mismatch never installs half of this ABI.
function transform(source: string, edits: readonly Edit[], guards: readonly string[] = []): string {
  for (const seam of [...edits.map(([before]) => before), ...guards]) {
    if (source.split(seam).length !== 2) throw new Error(ERROR);
  }
  for (const [before, after] of edits) source = source.replace(before, after);
  return source;
}

/** Pure Aerial-side transform, for a subclass's protected setFragmentShader.
 * Compose with the depth/diagnostic transforms; install together with
 * configureCloudShadowStorage before rendering any shadow/history textures.
 * Applying either adapter twice is an error. Recreate the effects to disable.
 */
export function stableAerialShadowStorage(source: string): string {
  if (source.includes(DECODED_READ)) throw new Error(ERROR);
  return transform(source, [[READ, DECODED_READ]], [
    '  return min(shadow.b, shadow.g * max(0.0, distanceToTop - shadow.r));',
  ]);
}

/** Install once on a fresh CloudsEffect, before its first render. Changes only
 * the shadow producer, shadow history's unit-dependent epsilon, and cloud
 * shadow readers (including the built-in debug view). Aerial is paired above.
 * Camera-cloud depth, shadow range, UV velocity and transport stay physical.
 */
export function configureCloudShadowStorage(clouds: CloudsEffect): void {
  const current = clouds.shadowPass.currentMaterial;
  const resolve = clouds.shadowPass.resolveMaterial;
  const consumer = clouds.cloudsPass.currentMaterial;
  if (consumer.fragmentShader.includes(DECODED_READ)) throw new Error(ERROR);

  const shadowSource = transform(current.fragmentShader, [
    [
      '  float frontDepth = min(weightedDistanceSum / transmittanceSum, maxRayDistance);',
      `  // The first opaque step can underflow every transmittance weight to zero.
  // Use that physical sample position for motion instead of producing 0 / 0.
  float frontDepth = transmittanceSum > 0.0
    ? min(weightedDistanceSum / transmittanceSum, maxRayDistance)
    : min(rayDistance, maxRayDistance);`,
    ],
    ['  outputColor = color;', `  outputColor = color * ${ENCODE}; // Encode only the stored copy.`],
    [
      '  outputDepthVelocity = vec3(color.x, velocity);',
      '  outputDepthVelocity = vec3(color.x * 1e-4, velocity); // Only used for nearest-motion ordering.',
    ],
  ], [
    '    return vec4(maxRayDistance, 0.0, 0.0, 0.0);',
    '  return vec4(frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail);',
    '  vec3 frontPosition = color.x * rayDirection + rayOrigin;',
    '  outputDepthVelocity = vec3(0.0);',
    '        maxOpticalDepth += media.extinction * stepSize;',
    '        stepSize * 0.5 // Excessive optical depth only introduces aliasing.',
  ]);

  const resolveSource = transform(resolve.fragmentShader, [[
    '  vec3 eClip = 0.5 * (maxColor.rgb - minColor.rgb) + 1e-7;',
    '  vec3 eClip = 0.5 * (maxColor.rgb - minColor.rgb) + vec3(1e-10, 1e-4, 1e-10);',
  ]], [
    '  vec4 result = vec4(1e7, 0.0, 0.0, 0.0);',
    '  vec2 velocity = depthVelocity.gb * texelSize;',
    '  outputColor = mix(clippedHistory, current, temporalAlpha);',
  ]);

  const cloudSource = transform(consumer.fragmentShader, [
    [READ, DECODED_READ],
    [
      '  const float frontDepthScale = 1e-5;',
      `  shadow *= ${DECODE}; // Debug views use physical shadow units too.\n  const float frontDepthScale = 1e-5;`,
    ],
  ], [
    '  float distanceToFront = max(0.0, distanceToTop - distanceOffset - shadow.r);',
    '  return min(shadow.b + shadow.a, shadow.g * distanceToFront);',
    ...['xw, 0.0', 'zw, 1.0', 'xy, 2.0', 'zy, 3.0'].map(
      coord => `      shadow = texture(shadowBuffer, vec3(coord.${coord}));`,
    ),
  ]);

  current.fragmentShader = shadowSource;
  resolve.fragmentShader = resolveSource;
  consumer.fragmentShader = cloudSource;
  current.needsUpdate = resolve.needsUpdate = consumer.needsUpdate = true;
}

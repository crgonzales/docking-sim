export type WavelengthTriple = readonly [number, number, number];
export type MathVec3 = readonly [number, number, number];

const PI = Math.PI;

/** Relative beta values for the red, green, and blue wavelengths. */
export function deriveRayleighCoefficients(
  wavelengthsNm: WavelengthTriple = [680, 550, 440],
): WavelengthTriple {
  const reference = 1 / wavelengthsNm[0] ** 4;
  return [
    (1 / wavelengthsNm[0] ** 4) / reference,
    (1 / wavelengthsNm[1] ** 4) / reference,
    (1 / wavelengthsNm[2] ** 4) / reference,
  ];
}

export function rayleighPhase(cosTheta: number): number {
  const cosine = Math.max(-1, Math.min(1, cosTheta));
  return (3 / (16 * PI)) * (1 + cosine * cosine);
}

export function henyeyGreensteinPhase(cosTheta: number, anisotropy = 0.76): number {
  const cosine = Math.max(-1, Math.min(1, cosTheta));
  const g = Math.max(-0.999, Math.min(0.999, anisotropy));
  const denominator = Math.max(1 + g * g - 2 * g * cosine, Number.EPSILON);
  return (1 - g * g) / (4 * PI * denominator ** 1.5);
}

function normalize([x, y, z]: MathVec3): MathVec3 {
  const length = Math.hypot(x, y, z);
  if (length === 0) return [0, 0, 0];
  return [x / length, y / length, z / length];
}

function sphericalUv([x, y, z]: MathVec3): readonly [number, number] {
  return [
    Math.atan2(z, -x) / (2 * PI),
    0.5 + Math.asin(Math.max(-1, Math.min(1, y))) / PI,
  ];
}

function rotateY([x, y, z]: MathVec3, angle: number): MathVec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * x + s * z, y, -s * x + c * z];
}

/**
 * Mirror the surface shader's sun-projected blocker point in pure TypeScript.
 * The renderer shader samples the returned spherical UV directly; this seam
 * is useful for testing projection direction and pole/seam clamping.
 */
export function computeCloudShadowUv(
  surfaceNormal: MathVec3,
  sunDirection: MathVec3,
  cloudAltitude: number,
  surfaceRadius: number,
  cloudRotationOffset: number,
): readonly [number, number] {
  const normal = normalize(surfaceNormal);
  const sun = normalize(sunDirection);
  const ndotl = normal[0] * sun[0] + normal[1] * sun[1] + normal[2] * sun[2];
  if (ndotl <= 0) return sphericalUv(normal);

  const tangent = normalize([
    sun[0] - normal[0] * ndotl,
    sun[1] - normal[1] * ndotl,
    sun[2] - normal[2] * ndotl,
  ]);
  const angularOffset = cloudAltitude / Math.max(surfaceRadius * Math.max(ndotl, 0.08), 0.0001);
  const blocker = normalize([
    normal[0] + tangent[0] * angularOffset,
    normal[1] + tangent[1] * angularOffset,
    normal[2] + tangent[2] * angularOffset,
  ]);
  const localBlocker = rotateY(blocker, -cloudRotationOffset);
  const [u, v] = sphericalUv(localBlocker);
  return [((u % 1) + 1) % 1, Math.max(0.001, Math.min(0.999, v))];
}

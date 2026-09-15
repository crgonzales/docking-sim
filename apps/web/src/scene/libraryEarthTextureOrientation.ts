/**
 * Packaged Earth KTX2 asset contract: rows run north to south, while engine
 * spherical/SphereGeometry UVs put north at v=1. KTX2Loader uploads these rows
 * without flipping. The checked-in assets have no KTXorientation metadata;
 * their orientation is pinned by decoding day/spec pixels in the companion test.
 *
 * Apply only at the texture lookup, after constructing geographic UVs. This
 * preserves longitude, geometry, normals and procedural UVs. This is not a
 * generic KTX mapper: already-flipped JPG/PNG textures and the structured
 * weather DataTexture use their existing UVs. Do not set compressed flipY.
 *
 * Consumers: the Earth globe (day/spec) and terrain patches (day/spec); the
 * retired renderer's night, normal and cloud lookups no longer exist.
 */
export const EARTH_KTX_UV_GLSL = /* glsl */ `
  vec2 earthMapUv(vec2 uv) {
    return vec2(uv.x, 1.0 - uv.y);
  }

  // This compressed specular asset has nonzero gray values over dry land.
  // Treat it as a geographic classifier, not a literal ocean-area fraction:
  // weak land reflectivity must not receive the much brighter ocean BRDF.
  // Keep a filtered shoreline interval, shared by globe, terrain and normals.
  float earthWaterFraction(float value) {
    return smoothstep(0.4, 0.6, value);
  }

  // The packaged day image is display-oriented imagery, not measured surface
  // reflectance. Lift its very dark land colors before physical illumination;
  // preserve hue and keep reflectance bounded, including bright snow/ice.
  vec3 earthSurfaceAlbedo(vec3 imageColor) {
    vec3 color = clamp(imageColor, 0.0, 1.0);
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float gain = pow(max(luminance, 0.0001), -0.3);
    return min(color * gain, vec3(0.9));
  }
`;

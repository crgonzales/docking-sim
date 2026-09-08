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
 * Initial LIBRARY consumers: Earth day/spec and terrain day. Legacy Earth
 * day/night/spec/normal and KTX cloud lookups need a separate coordinated
 * change (including cloud coverage/placement and normal tangent conventions).
 */
export const EARTH_KTX_UV_GLSL = /* glsl */ `
  vec2 earthMapUv(vec2 uv) {
    return vec2(uv.x, 1.0 - uv.y);
  }
`;

struct GroundIrradiance {
  vec3 sun;
  vec3 sky;
};

struct CloudsIrradiance {
  vec3 minSun;
  vec3 minSky;
  vec3 maxSun;
  vec3 maxSky;
};

struct CloudDensityProfile {
  vec4 expTerms;
  vec4 exponents;
  vec4 linearTerms;
  vec4 constantTerms;
};

struct CloudLightingSample {
  // Cloud transmittance from sunStartM to the conservative cloud-support exit.
  float directTransmittance;
  // Sky irradiance after the complete cloud-support path.
  vec3 skyIrradiance;
  // 1 when the backend supplied a valid lighting sample, otherwise 0.
  float valid;
  // 1 selects the stock Beer/ambient fallback when a hook is invalid.
  float stockFallback;
  // Backend generation; the corresponding value belongs to shared uniforms.
  float generation;
};

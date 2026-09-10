// Stock media hook for the pinned Takram implementation.
// Custom backends replace this named include with a function using ECEF metres,
// inverse-metre coefficients, physical footprintM, weatherLod and jitter.
MediaSample sampleCloudMedia(
  const vec3 positionECEFM,
  const float footprintM,
  const float weatherLod,
  const float jitter
) {
  MediaSample empty;
  empty.density = 0.0;
  empty.weight = vec4(0.0);
  empty.scattering = 0.0;
  empty.extinction = 0.0;
  empty.phaseAnisotropy = cloudScatterAnisotropy;
  empty.phaseMix = cloudScatterAnisotropyMix;

  float height = length(positionECEFM) - bottomRadius;
  if (!insideLayerIntervals(height)) {
    vec2 uv = getGlobeUv(positionECEFM);
    WeatherSample weather = sampleWeather(uv, height, weatherLod);
    if (any(greaterThan(weather.density, vec4(minDensity)))) {
      ivec3 sampleCount;
      return sampleMedia(weather, positionECEFM, uv, weatherLod, jitter, sampleCount);
    }
  }
  return empty;
}

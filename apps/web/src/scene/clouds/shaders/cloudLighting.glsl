CloudLightingSample sampleCloudLighting(vec3 positionECEFM, float footprintM, float sunStartM) {
  CloudLightingSample result;
  result.directTransmittance = volumetricSunTransmittance(positionECEFM, sunStartM, footprintM);
  vec3 clearSky;
  vec3 atmospherePosition = positionECEFM + altitudeCorrection;
  getCloudsSunSkyIrradiance(atmospherePosition, length(atmospherePosition) - bottomRadius, clearSky);
  result.skyIrradiance = clearSky * volumetricSkyVisibility(positionECEFM, footprintM);
  result.valid = 1.0; // Either valid cache or explicitly integrated fallback.
  result.stockFallback = 0.0;
  result.generation = volumetricLightGeneration;
  return result;
}

// Invalid stock hook preserves Takram's built-in Beer-map and ambient terms.
// A backend-provided include returns valid=1 and owns the direct/sky transport.
CloudLightingSample sampleCloudLighting(
  const vec3 positionECEFM,
  const float footprintM,
  const float sunStartM
) {
  CloudLightingSample result;
  result.directTransmittance = 1.0;
  result.skyIrradiance = vec3(0.0);
  result.valid = 0.0;
  result.stockFallback = 1.0;
  result.generation = 0.0;
  return result;
}

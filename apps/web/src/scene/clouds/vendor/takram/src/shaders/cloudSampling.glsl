// Reserve the remaining ray with a geometric step floor. The ratio is the
// square-root of perspective growth so the floor stays below the native
// multiplier while still covering the complete suffix. At ratio one this is
// the uniform allocation used by the distant schedule; reference bypasses it.
float cloudBudgetStep(const float remainingLength, const float remainingSteps, const float perspectiveScale) {
  if (remainingSteps <= 0.0) return remainingLength;
  float ratio = sqrt(max(perspectiveScale, 1.0));
  if (abs(ratio - 1.0) < 1e-5) return remainingLength / remainingSteps;
  return remainingLength * (ratio - 1.0) / (pow(ratio, remainingSteps) - 1.0);
}

// Temporal-upscale primary rays are rendered at quarter resolution. Address
// STBN in final-pixel space and advance its depth only after a full Bayer cycle.
float samplePrimarySTBN(const vec2 fullPixel, const int frameIndex) {
  ivec3 size = textureSize(stbnTexture, 0);
  ivec2 pixel = ivec2(mod(floor(fullPixel), vec2(size.xy)));
  int cycle = max(frameIndex, 0) / 16;
  return texelFetch(stbnTexture, ivec3(pixel, cycle % size.z), 0).r;
}

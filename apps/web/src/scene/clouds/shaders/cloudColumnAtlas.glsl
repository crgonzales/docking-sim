// Canonical radial integration comes from cloudColumn.glsl.
uniform float volumetricColumnAngularPixelRad;
uniform int volumetricColumnSegmentCount;
in vec2 vUv;
layout(location=0) out vec4 volumetricColumnValue;
void main() {
  // Filter completed columns, never threshold prefiltered density noise.
  vec2 texel = vec2(volumetricColumnAngularPixelRad / (2.0 * PI), volumetricColumnAngularPixelRad / PI);
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) {
      vec2 uv = vUv + (vec2(float(x), float(y)) - 0.5) * 0.5 * texel;
      sum += volumetricIntegrateRadialColumn(volumetricColumnDirectionFromUv(uv), volumetricColumnSegmentCount, 0.0);
    }
  }
  volumetricColumnValue = 0.25 * sum;
}

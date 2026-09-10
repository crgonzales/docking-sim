// Canonical radial integration comes from cloudColumn.glsl.
uniform float eveColumnAngularPixelRad;
uniform int eveColumnSegmentCount;
in vec2 vUv;
layout(location=0) out vec4 eveColumnValue;
void main() {
  // Filter completed columns, never threshold prefiltered density noise.
  vec2 texel = vec2(eveColumnAngularPixelRad / (2.0 * PI), eveColumnAngularPixelRad / PI);
  vec4 sum = vec4(0.0);
  for (int y = 0; y < 2; ++y) {
    for (int x = 0; x < 2; ++x) {
      vec2 uv = vUv + (vec2(float(x), float(y)) - 0.5) * 0.5 * texel;
      sum += eveIntegrateRadialColumn(eveColumnDirectionFromUv(uv), eveColumnSegmentCount, 0.0);
    }
  }
  eveColumnValue = 0.25 * sum;
}

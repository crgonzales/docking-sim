// Common cloud-only transport. Requires canonical sampleCloudMedia and the
// same frozen weather uniforms as the view. No atmosphere attenuation here.
uniform vec2 eveCloudAltitudeBoundsM;
uniform float eveCloudPlanetRadiusM;

vec2 eveSphereInterval(vec3 p, vec3 d, float radius) {
  float b = dot(p, d);
  float discriminant = b * b - dot(p, p) + radius * radius;
  if (discriminant < 0.0) return vec2(-1.0);
  float root = sqrt(max(0.0, discriminant));
  return vec2(-b - root, -b + root);
}

vec2 eveCloudRayInterval(vec3 p, vec3 d, float startM) {
  vec2 outer = eveSphereInterval(p, d, eveCloudPlanetRadiusM + eveCloudAltitudeBoundsM.y);
  float begin = max(max(0.0, startM), outer.x);
  float end = outer.y;
  vec2 ground = eveSphereInterval(p, d, eveCloudPlanetRadiusM);
  if (ground.x >= 0.0) end = min(end, ground.x);
  // Below the lowest cloud altitude, first travel to its sun-facing crossing.
  if (length(p + begin * d) < eveCloudPlanetRadiusM + eveCloudAltitudeBoundsM.x) {
    vec2 inner = eveSphereInterval(p, d, eveCloudPlanetRadiusM + eveCloudAltitudeBoundsM.x);
    begin = max(begin, inner.y);
  }
  return vec2(begin, max(begin, end));
}

float eveDirectIntegration(vec3 p, vec3 d, float startM, int budget, float footprintM) {
  vec2 interval = eveCloudRayInterval(p, d, startM);
  float span = interval.y - interval.x;
  if (span <= 0.0) return 1.0;
  int count = clamp(budget, 1, 64);
  float segment = span / float(count);
  float opticalDepth = 0.0;
  for (int i = 0; i < 64; ++i) {
    if (i >= count) break;
    vec3 position = p + (interval.x + (float(i) + 0.5) * segment) * d;
    MediaSample media = sampleCloudMedia(position, footprintM, 0.0, 0.5);
    opticalDepth += max(0.0, media.extinction) * segment;
    if (opticalDepth >= 16.0) break;
  }
  return exp(-opticalDepth);
}

// Cosine-weighted hemisphere approximation to cloud-occluded diffuse sky.
// The cache stores the scalar visibility, not an extra direct-light shadow.
float eveAmbientIntegration(vec3 p, int rayCount, int steps, float footprintM) {
  vec3 n = normalize(p);
  vec3 x = normalize(cross(abs(n.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0), n));
  vec3 y = cross(n, x);
  float visibility = 0.0;
  int count = clamp(rayCount, 1, 8);
  for (int i = 0; i < 8; ++i) {
    if (i >= count) break;
    float u = (float(i) + 0.5) / float(count);
    float angle = float(i) * 2.399963229728653;
    vec3 d = sqrt(u) * (cos(angle) * x + sin(angle) * y) + sqrt(1.0 - u) * n;
    visibility += eveDirectIntegration(p, d, 0.0, steps, footprintM);
  }
  return visibility / float(count);
}

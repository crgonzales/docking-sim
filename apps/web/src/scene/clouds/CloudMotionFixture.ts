import { ShaderPass } from 'postprocessing';
import { AtmosphereParameters } from '@takram/three-atmosphere';
import {
  BasicDepthPacking, Data3DTexture, DataTexture, FloatType, GLSL3, LinearFilter,
  Matrix3, Matrix4, NearestFilter, NoBlending, PerspectiveCamera, RawShaderMaterial,
  RepeatWrapping, RGBAFormat, Uniform, Vector2, Vector3, Vector4, WebGLRenderTarget,
  type Texture, type WebGLRenderer,
} from 'three';
import type { CloudConformanceResult } from './CloudConformanceFixture';
import type { CloudConformanceResources } from './CloudConformanceResources';
import { createWeatherBindingUniforms, createWeatherSnapshot, sampleWeatherField, sampleWeatherFieldWithMotion } from './cloudWeather';
import { loadCloudWeatherAssets, type CloudWeatherAssets } from './cloudWeatherAssets';
import { EVE_REFERENCE_REGION } from './cloudConfig';
import {
  canonicalWeatherPositionECEFM, createWeatherMotionState, rotateWeatherEcefAroundNorth,
  sampleSeededWeatherFront,
} from './cloudMotion';
import {
  CloudsMaterial, createAtmosphereUniforms, createCloudLayerUniforms,
  createCloudParameterUniforms, createCloudShaderHooks,
} from './takramCloudBackend';
// CloudsPass and its shadow owner have no facade exports. Use their real
// lifecycle here; do not reproduce the stationary-camera predicate in a test.
import { CloudsPass } from './vendor/takram/src/CloudsPass';
import { CascadedShadowMaps } from './vendor/takram/src/CascadedShadowMaps';
import densityGLSL from './shaders/cloudDensity.glsl?raw';
import columnGLSL from './shaders/cloudColumn.glsl?raw';
import distantGLSL from './shaders/distantCloud.glsl?raw';

type Position = readonly [number, number, number];
type RecordCase = (name: string, measured: readonly number[], expected: readonly number[], bound?: number) => void;
const radius = 6_371_000;
const day = 86_400;
const marker = [7, 11, 13, 17];
const vertexShader = 'precision highp float; in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const at = (lat: number, lon: number, height = 0): Position => [
  (radius + height) * Math.cos(lat) * Math.cos(lon),
  (radius + height) * Math.cos(lat) * Math.sin(lon),
  (radius + height) * Math.sin(lat),
];
const delta = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v - b[i]!);
const spread = (values: readonly number[]) => Math.max(...values) - Math.min(...values);

// Synthetic inputs have deliberately independent map channels and a smooth,
// periodic 3D pattern. The production shader performs all sampling/shaping.
function mapTexture(width: number, height: number, sample: (u: number, v: number) => readonly number[]): DataTexture {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set(sample((x + 0.5) / width, (y + 0.5) / height), (y * width + x) * 4);
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function noiseTexture(): Data3DTexture {
  const size = 16;
  const data = new Float32Array(size ** 3 * 4);
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const phase = 2 * Math.PI * (x + 2 * y + z + 2) / size;
    data.set([0.55 + 0.25 * Math.sin(phase), 0.6 + 0.3 * Math.cos(phase),
      0.5, 0.5 + 0.4 * Math.sin(phase + 1)], ((z * size + y) * size + x) * 4);
  }
  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RGBAFormat;
  texture.type = FloatType;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// The unused distant lighting ABI is constant. eveReadColumn, radial column
// integration, weather lookup, front generation, and media are all production.
const fieldFragment = `precision highp float;
precision highp int; precision highp sampler2D; precision highp sampler3D;
const float PI = 3.141592653589793;
const float RECIPROCAL_PI = 0.3183098861837907;
const float RECIPROCAL_PI2 = 0.15915494309189535;
const float RECIPROCAL_PI4 = 0.07957747154594767;
const float METER_TO_LENGTH_UNIT = 0.001;
struct MediaSample { float density; vec4 weight; float scattering; float extinction; vec2 phaseAnisotropy; float phaseMix; };
struct CloudLightingSample { float valid; vec3 skyIrradiance; };
${densityGLSL}
${columnGLSL}
const float cloudEntryFootprintM = 0.0, cloudRaySlope = 0.0, skyLightScale = 1.0;
const float minHeight = 1000.0, maxHeight = 14000.0;
const vec3 altitudeCorrection = vec3(0.0), sunDirection = vec3(1.0, 0.0, 0.0);
vec3 GetSunAndSkyScalarIrradiance(vec3 p, vec3 s, out vec3 sky) { sky = vec3(1.0); return vec3(0.0); }
float approximateMultipleScattering(float t, float c, vec2 a, float m) { return 0.0; }
float eveSkyVisibility(vec3 p, float f) { return 1.0; }
${distantGLSL}
float cloudSunOpticalDepth(const vec3 p, const float f, const float l, const float j, out CloudLightingSample light) {
  light.valid = 1.0; light.skyIrradiance = vec3(1.0); return 0.0;
}
uniform vec3 fixturePosition;
uniform vec2 fixtureAtlasUv;
uniform int fixtureMode;
out vec4 result;
void main() {
  if (fixtureMode != 4 && int(gl_FragCoord.x) == 1) { result = vec4(7.0, 11.0, 13.0, 17.0); return; }
  if (fixtureMode == 0) result = vec4(eveSeededWeatherFront(eveWeatherCanonicalPositionECEFM(fixturePosition)), 0.0, 7.0);
  else if (fixtureMode == 1) result = vec4(eveSampleWeather(fixturePosition, 0.0, 0.0), 0.0, 7.0);
  else if (fixtureMode == 2) {
    MediaSample media = sampleCloudMedia(fixturePosition, 0.0, 0.0, 0.5);
    result = vec4(media.density, 1000.0 * media.extinction, 1000.0 * media.scattering, 7.0);
  } else if (fixtureMode == 3) result = eveReadColumn(fixturePosition, 0.0);
  else if (fixtureMode == 4) result = eveIntegrateRadialColumn(eveColumnDirectionFromUv(gl_FragCoord.xy / eveColumnDimensions), 32, 0.0);
  else if (fixtureMode == 5) result = textureLod(eveColumnTexture, fixtureAtlasUv, 0.0);
  else result = eveIntegrateRadialColumn(normalize(fixturePosition), 32, 0.0);
}`;

async function verifyField(renderer: WebGLRenderer, resources: CloudConformanceResources, record: RecordCase): Promise<void> {
  const coverage = mapTexture(64, 32, (u, v) => [0.5 + 0.3 * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * v), 0, 0, 1]);
  const type = mapTexture(64, 32, (u, v) => [0.4 + 0.3 * Math.cos(4 * Math.PI * u) * Math.sin(Math.PI * v), 0, 0, 1]);
  const reference = mapTexture(32, 16, (u, v) => [0.2 + 0.6 * u, 0.1 + 0.7 * v, 0, 1]);
  const solid = mapTexture(1, 1, () => [1, 0, 0, 1]);
  const noise = noiseTexture();
  const zone = EVE_REFERENCE_REGION.zones.deepGroup;
  const oraclePosition = at(zone.latitudeDeg * Math.PI / 180, zone.longitudeDeg * Math.PI / 180);
  const authored = sampleWeatherField(oraclePosition);
  const oracleCoverage = mapTexture(1, 1, () => [authored.coverage, 0, 0, 1]);
  const oracleType = mapTexture(1, 1, () => [authored.typeField, 0, 0, 1]);
  let assets: CloudWeatherAssets | undefined;
  const snapshot = createWeatherSnapshot({ planetRadiusM: radius, visualTimeS: 0, sunDirectionECEF: [1, 0, 0] });
  const uniforms: Record<string, Uniform<unknown>> = {
    ...createWeatherBindingUniforms(snapshot, { coverage, typeField: type, referenceField: reference, noise }),
    fixturePosition: new Uniform(new Vector3()), fixtureAtlasUv: new Uniform(new Vector2()), fixtureMode: new Uniform(0),
    eveColumnTexture: new Uniform(solid), eveColumnDimensions: new Uniform(new Vector2(32, 16)),
    eveColumnReady: new Uniform(1), eveColumnGeneration: new Uniform(0),
  };
  const material = new RawShaderMaterial({ glslVersion: GLSL3, depthTest: false, depthWrite: false,
    blending: NoBlending, uniforms, vertexShader, fragmentShader: fieldFragment });
  const pass = new ShaderPass(material);
  const target = new WebGLRenderTarget(2, 1, { type: FloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
  const atlas = new WebGLRenderTarget(32, 16, { type: FloatType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  atlas.texture.wrapS = RepeatWrapping;
  const setMotion = (time: number, enabled = true) => {
    const motion = createWeatherMotionState(time, radius, enabled);
    uniforms.eveWeatherMotionEnabled.value = enabled ? 1 : 0;
    uniforms.eveWeatherMotionAngleRad.value = motion.angleRad;
    uniforms.eveWeatherMotionTimeS.value = time;
    return motion;
  };
  const read = async (mode: number, position: Position, time: number, enabled = true): Promise<number[]> => {
    setMotion(time, enabled);
    (uniforms.fixturePosition.value as Vector3).fromArray(position);
    uniforms.fixtureMode.value = mode;
    resources.draw(() => pass.render(renderer, null, target));
    const pixels = new Float32Array(8).fill(NaN);
    renderer.readRenderTargetPixels(target, 0, 0, 2, 1, pixels);
    // A missing/failed shader draw must not pass an empty-field identity.
    if (marker.some((value, i) => pixels[i + 4] !== value)) throw new Error('Weather-motion field draw marker missing');
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return Array.from(pixels.slice(0, 4));
  };
  try {
    for (const lat of [-70, -20, 7, 55]) {
      const latitude = lat * Math.PI / 180;
      const epsilon = 1e-6;
      const west = await read(0, at(latitude, -Math.PI + epsilon), 0);
      const east = await read(0, at(latitude, Math.PI - epsilon), 0);
      record(`front-antimeridian-${lat}`, delta(west, east), [0, 0, 0, 0], 64 * epsilon + 3e-5);
      record(`front-cpu-parity-${lat}`, west.slice(0, 2), sampleSeededWeatherFront(at(latitude, -Math.PI + epsilon)), 3e-5);
    }
    for (const sign of [-1, 1]) {
      const pole = await read(0, [0, 0, sign * radius], 0);
      record(`front-pole-${sign}-finite`, [Number(pole.every(Number.isFinite)), pole[3]!], [1, 7]);
      for (const epsilon of [1e-4, 1e-6]) {
        const errors: number[] = [];
        for (const longitude of [-Math.PI, -2, -1, 0, 1, 2, Math.PI]) {
          errors.push(...delta((await read(0, at(sign * (Math.PI / 2 - epsilon), longitude), 0)).slice(0, 2), pole.slice(0, 2)));
        }
        record(`front-pole-${sign}-ring-${epsilon}`, errors, errors.map(() => 0), 64 * epsilon + 3e-5);
      }
    }
    // Sample the actual verified weather assets at the user's site, in addition
    // to front-only parity. The CPU reference map does not cover this location.
    assets = await loadCloudWeatherAssets();
    uniforms.eveWeatherCoverageTexture.value = assets.textures.coverage;
    uniforms.eveWeatherTypeFieldTexture.value = assets.textures.typeField;
    uniforms.eveWeatherReferenceFieldTexture.value = assets.textures.referenceField;
    for (const [lat, lon] of [[6.9, -0.08], [7, 0.02], [7.1, 0.12]]) {
      const p = at(lat * Math.PI / 180, lon * Math.PI / 180);
      const series: number[][] = [];
      const weatherSeries: number[][] = [];
      for (let hour = 0; hour <= 24; hour++) {
        const measured = await read(0, p, hour * 3600);
        const canonical = canonicalWeatherPositionECEFM(p, createWeatherMotionState(hour * 3600, radius));
        record(`front-base7degN-${lat}-${lon}-hour-${hour}`, measured, [...sampleSeededWeatherFront(canonical), 0, 7], 3e-5);
        series.push(measured);
        weatherSeries.push(await read(1, p, hour * 3600));
      }
      record(`front-base7degN-${lat}-${lon}-24h-varies`, [0, 1].map(c => Number(spread(series.map(v => v[c]!)) > 0.15)), [1, 1]);
      record(`front-base7degN-${lat}-${lon}-paused-repeat`, await read(0, p, day), series[24]!);
      record(`actual-weather-base7degN-${lat}-${lon}-bounded`,
        [Number(weatherSeries.every(v => v.slice(0, 2).every(c => Number.isFinite(c) && c >= 0 && c <= 1)))], [1]);
      record(`actual-weather-base7degN-${lat}-${lon}-24h-varies`,
        [0, 1].map(c => Number(spread(weatherSeries.map(v => v[c]!)) > 0.15)), [1, 1]);
      record(`actual-weather-base7degN-${lat}-${lon}-paused-repeat`, await read(1, p, day), weatherSeries[24]!);
    }
    uniforms.eveWeatherCoverageTexture.value = coverage;
    uniforms.eveWeatherTypeFieldTexture.value = type;
    uniforms.eveWeatherReferenceFieldTexture.value = reference;

    const time = day * 0.75;
    const angle = createWeatherMotionState(time, radius).angleRad;
    const mapPoints = [at(0.12, 0.00035, 2500), at(-0.5, 2, 4000), at(40.5 * Math.PI / 180, -75 * Math.PI / 180, 3000)];
    for (const enabledReference of [0, 1]) {
      uniforms.eveWeatherReferenceFieldEnabled.value = enabledReference;
      const values: number[][] = [];
      for (const [i, p] of mapPoints.entries()) {
        const baseline = await read(1, p, 0);
        const moved = await read(1, rotateWeatherEcefAroundNorth(p, angle), time);
        record(`maps-reference-${enabledReference}-rigid-${i}`, moved, baseline, 3e-5);
        values.push(baseline);
      }
      record(`maps-reference-${enabledReference}-both-channels-nonconstant`, [0, 1].map(c => Number(spread(values.map(v => v[c]!)) > 0.02)), [1, 1]);
    }
    const p = mapPoints[2]!;
    record('disabled-keeps-authored-field', await read(1, p, day, false), await read(1, p, 0, false));

    // Independent CPU/GPU agreement for the APPLIED coverage/type modulation,
    // with identical authored inputs. This catches a stale CPU mirror even if
    // the seeded-front function alone agrees perfectly.
    uniforms.eveWeatherCoverageTexture.value = oracleCoverage;
    uniforms.eveWeatherTypeFieldTexture.value = oracleType;
    uniforms.eveWeatherReferenceFieldEnabled.value = 0;
    for (const timeS of [0, day * 0.5, day]) {
      const motion = createWeatherMotionState(timeS, radius);
      const live = rotateWeatherEcefAroundNorth(oraclePosition, motion.angleRad);
      const expected = sampleWeatherFieldWithMotion(live, motion);
      record(`applied-front-cpu-gpu-${timeS}`, await read(1, live, timeS), [expected.coverage, expected.typeField, 0, 7], 3e-5);
    }
    uniforms.eveWeatherTypeFieldTexture.value = type;

    // Isolate each actual texture domain inside sampleCloudMedia. Broad support
    // and identical profile tables prevent empty/thin layers hiding a regression.
    uniforms.eveWeatherCoverageTexture.value = solid;
    uniforms.eveWeatherReferenceFieldEnabled.value = 0;
    for (const [name, value] of Object.entries({ eveCloudBaseAltitudeM: 1000, eveCloudTopAltitudeM: 9000,
      eveCloudPrimaryNoiseScaleM: 160_000, eveCloudDetailNoiseScaleM: 73_000,
      eveCloudBaseNoiseThreshold: 0.5, eveCloudBaseNoiseSoftness: 0.5, eveCloudErosionDepth: 0 })) {
      (uniforms[name]!.value as Vector4).setScalar(value);
    }
    // Put the noise witness on the coverage shoulder rather than the saturated
    // clear/solid plateaus. The production smoothstep then exposes changes in
    // the selected texture domain instead of letting front coverage hide them.
    uniforms.eveCloudCoverageEdgeSoftness.value = 0.25;
    for (const curve of uniforms.eveCloudCoverageValues.value as Vector4[]) curve.setScalar(0.5);
    for (const curve of uniforms.eveCloudDensityValues.value as Vector4[]) curve.setScalar(1);
    const densityPoints = Array.from({ length: 12 }, (_, i) => at(0.12 + i * 0.025, -0.15 + i * 0.027, 4200));
    for (const [name, detailMix] of [['primary', 0], ['detail', 1], ['both', 0.4]] as const) {
      uniforms.eveCloudDetailSupportMix.value = detailMix;
      (uniforms.eveCloudErosionDepth.value as Vector4).setScalar(name === 'both' ? 0.34 : 0);
      const baseline: number[][] = [], frozen: number[][] = [];
      for (const [i, point] of densityPoints.entries()) {
        const before = await read(2, point, 0);
        const livePoint = rotateWeatherEcefAroundNorth(point, angle);
        // Earth-scale float rotations feed a nonlinear coverage edge; the
        // standard media tolerance is still 50x below the sensitivity witness.
        record(`density-${name}-rigid-${i}`, await read(2, livePoint, time), before, 1e-3);
        baseline.push(before);
        frozen.push(await read(2, livePoint, 0));
      }
      record(`density-${name}-nonempty-and-sensitive`, [
        Number(Math.max(...baseline.map(v => v[0]!)) > 0.1),
        Number(spread(baseline.map(v => v[0]!)) > 0.05),
        Number(Math.max(...baseline.map((v, i) => Math.abs(v[0]! - frozen[i]![0]!))) > 0.05),
      ], [1, 1, 1]);
      if (name !== 'both') {
        // A coordinate identity alone could pass if one domain were omitted or
        // aliased to the other. Perturb each domain's physical scale separately
        // and require only the selected domain to affect the actual density.
        const selected = uniforms[name === 'primary' ? 'eveCloudPrimaryNoiseScaleM' : 'eveCloudDetailNoiseScaleM']!.value as Vector4;
        const other = uniforms[name === 'primary' ? 'eveCloudDetailNoiseScaleM' : 'eveCloudPrimaryNoiseScaleM']!.value as Vector4;
        const originalSelected = selected.clone(), originalOther = other.clone();
        const selectedDifferences: number[] = [];
        other.multiplyScalar(1.27);
        for (const [i, point] of densityPoints.entries()) {
          record(`density-${name}-ignores-other-domain-scale-${i}`, await read(2, point, 0), baseline[i]!, 1e-3);
        }
        other.copy(originalOther);
        selected.multiplyScalar(1.13);
        for (const [i, point] of densityPoints.entries()) {
          selectedDifferences.push(Math.abs((await read(2, point, 0))[0]! - baseline[i]![0]!));
        }
        record(`density-${name}-requires-selected-noise-domain`, [Number(Math.max(...selectedDifferences) > 0.05)], [1]);
        selected.copy(originalSelected);
      }
    }

    // A tiny probe atlas, baked once in the canonical frame by the production
    // radial integrator. This checks actual distant lookup addressing without
    // allocating or rebuilding the full production atlas during conformance.
    (uniforms.eveCloudErosionDepth.value as Vector4).setScalar(0);
    setMotion(0);
    uniforms.fixtureMode.value = 4;
    resources.draw(() => pass.render(renderer, null, atlas));
    uniforms.eveColumnTexture.value = atlas.texture;
    const columns: number[][] = [];
    for (const [x, y] of [[8, 6], [16, 8], [23, 10], [30, 7]]) {
      const uv = [(x + 0.5) / 32, (y + 0.5) / 16] as const;
      (uniforms.fixtureAtlasUv.value as Vector2).fromArray(uv);
      const canonical = at((uv[1] - 0.5) * Math.PI, (uv[0] - 0.5) * 2 * Math.PI);
      const referenceColumn = await read(5, canonical, 0);
      const live = rotateWeatherEcefAroundNorth(canonical, angle);
      record(`canonical-atlas-lookup-${x}-${y}`, await read(3, live, time), referenceColumn, 3e-4);
      record(`canonical-atlas-live-radial-${x}-${y}`, await read(6, live, time), referenceColumn, 2e-3);
      columns.push(referenceColumn);
    }
    record('canonical-atlas-nonempty-distinct-columns', [Number(Math.max(...columns.map(v => v[0]!)) > 0.1),
      Number(spread(columns.map(v => v[1]!)) > 0.01)], [1, 1]);
  } finally {
    pass.dispose(); material.dispose(); target.dispose(); atlas.dispose();
    assets?.dispose();
    for (const texture of [coverage, type, reference, solid, noise, oracleCoverage, oracleType]) texture.dispose();
  }
}

// Controlled homogeneous/empty observations isolate the actual marcher encoder
// and resolver from weather shape. No fixture supplies velocity or depth tuples.
const slabGLSL = `uniform float fixtureOccupied;
MediaSample sampleCloudMedia(vec3 p, float f, float l, float j) {
  float height = length(p) - ${radius}.0;
  float density = fixtureOccupied * step(1000.0, height) * (1.0 - step(2000.0, height));
  MediaSample m; m.density = density; m.weight = vec4(density, 0.0, 0.0, 0.0);
  m.extinction = density * 0.001; m.scattering = density * 0.0005;
  m.phaseAnisotropy = vec2(0.0); m.phaseMix = 0.0; return m;
}`;
const lightingGLSL = `CloudLightingSample sampleCloudLighting(vec3 p, float f, float s) {
  CloudLightingSample l; l.directTransmittance = 1.0; l.skyIrradiance = vec3(4.0 * PI);
  l.valid = 1.0; l.stockFallback = 0.0; l.generation = 0.0; return l;
}`;

function cameraAt(position: Vector3): PerspectiveCamera {
  const camera = new PerspectiveCamera(30, 1, 0.5, 10_000);
  camera.position.copy(position);
  camera.lookAt(position.clone().add(new Vector3(-1, 0, 0)));
  camera.updateMatrixWorld();
  return camera;
}

function configureMaterial(material: CloudsMaterial, resources: CloudConformanceResources): void {
  material.temporalUpscale = false;
  material.depthPacking = BasicDepthPacking;
  material.shadowLength = material.haze = material.shapeDetail = material.turbulence = false;
  material.accurateSunSkyLight = material.accuratePhaseFunction = false;
  material.multiScatteringOctaves = 1;
  material.transmittanceTexture = resources.one2D;
  material.irradianceTexture = resources.zero2D;
  material.scatteringTexture = resources.zero3D;
  const u = material.uniforms;
  u.depthBuffer.value = resources.depth.depthTexture;
  u.stbnTexture.value = resources.noise3D;
  u.shadowBuffer.value = resources.shadowArray;
  u.powderScale.value = u.groundBounceScale.value = 0;
  u.skyLightScale.value = 1;
  u.minDensity.value = u.minExtinction.value = u.minTransmittance.value = 1e-8;
  u.maxIterationCount.value = 512;
  u.maxIterationCountToSun.value = u.maxIterationCountToGround.value = 0;
  u.referenceSampling.value = 1;
  u.referenceStepSize.value = 10;
}

async function verifyReprojection(renderer: WebGLRenderer, resources: CloudConformanceResources, record: RecordCase): Promise<void> {
  const occupied = new Uniform(1);
  // Large tangential components make rotating the correction instead of the
  // physical front measurably wrong despite Earth-scale float quantization.
  const correction = new Vector3(-11_000, 37_000, -17_000);
  const worldToECEF = new Matrix4().makeTranslation(radius + 3000, 0, 0);
  const atmosphere = new AtmosphereParameters({ bottomRadius: radius - 11_000, topRadius: radius + 60_000, solarIrradiance: new Vector3() });
  const parameterUniforms = createCloudParameterUniforms({
    localWeatherTexture: resources.one2D, localWeatherRepeat: new Vector2(1, 1), localWeatherOffset: new Vector2(),
    shapeTexture: resources.one3D, shapeRepeat: new Vector3(0.001, 0.001, 0.001), shapeOffset: new Vector3(),
    shapeDetailTexture: resources.one3D, shapeDetailRepeat: new Vector3(0.01, 0.01, 0.01), shapeDetailOffset: new Vector3(),
    turbulenceTexture: resources.zero2D, turbulenceRepeat: new Vector2(1, 1),
  });
  const layerUniforms = createCloudLayerUniforms();
  // The geometric search uses atmosphere coordinates; keep it broad enough for
  // the independent physical 1–2 km slab and the deliberately oblique correction.
  layerUniforms.minHeight.value = layerUniforms.shadowBottomHeight.value = 0;
  layerUniforms.maxHeight.value = layerUniforms.shadowTopHeight.value = 20_000;
  const atmosphereUniforms = createAtmosphereUniforms(atmosphere, {
    worldToECEFMatrix: worldToECEF, ecefToWorldMatrix: worldToECEF.clone().invert(),
    altitudeCorrection: correction, sunDirection: new Vector3(1, 0, 0),
  });
  const options = { parameterUniforms, layerUniforms, atmosphereUniforms,
    shaderHooks: createCloudShaderHooks({ mediaGLSL: slabGLSL, lightingGLSL, uniforms: { fixtureOccupied: occupied } }) };
  const shadow = new CascadedShadowMaps({ cascadeCount: 1, mapSize: new Vector2(1, 1) });
  const cloudPass = new CloudsPass({ ...options, shadow }, atmosphere);
  cloudPass.temporalUpscale = false;
  cloudPass.lightShafts = false;
  configureMaterial(cloudPass.currentMaterial, resources);
  cloudPass.setSize(resources.size, resources.size);
  const packed = new WebGLRenderTarget(2, 1, { type: FloatType, depthBuffer: false });
  const packMaterial = new RawShaderMaterial({ glslVersion: GLSL3, depthTest: false, depthWrite: false,
    uniforms: { buffer: new Uniform(resources.one2D), fixturePixel: new Uniform(new Vector2(4, 4)) }, vertexShader,
    fragmentShader: `precision highp float; precision highp sampler2D;
      uniform sampler2D buffer; uniform vec2 fixturePixel; out vec4 value;
      void main() { value = int(gl_FragCoord.x) == 0 ? texelFetch(buffer, ivec2(fixturePixel), 0) : vec4(7.0, 11.0, 13.0, 17.0); }`,
  });
  const pack = new ShaderPass(packMaterial);
  const readTexture = async (texture: Texture, x = 4, y = 4): Promise<number[]> => {
    packMaterial.uniforms.buffer.value = texture;
    packMaterial.uniforms.fixturePixel.value.set(x, y);
    resources.draw(() => pack.render(renderer, null, packed));
    const values = new Float32Array(8).fill(NaN);
    renderer.readRenderTargetPixels(packed, 0, 0, 2, 1, values);
    if (marker.some((v, i) => values[i + 4] !== v)) throw new Error('Weather-motion velocity draw marker missing');
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return Array.from(values.slice(0, 4));
  };
  try {
    // Actual CloudsPass updates, including real history publication and resolve.
    cloudPass.mainCamera = cameraAt(new Vector3());
    resources.renderTerrain(2500);
    let frame = 0;
    const update = (angle: number, enabled: boolean) => {
      cloudPass.setMediaMotion(angle, enabled);
      resources.draw(() => cloudPass.update(renderer, frame++, 1 / 60));
    };
    const gate = (name: string, expected: boolean) => record(name,
      [Number(cloudPass.resolveMaterial.uniforms.stationaryCamera.value), Number(cloudPass.historyValid)], [Number(expected), 1]);
    update(0, true);
    update(0, true); gate('paused-stationary-eligible', true);
    update(createWeatherMotionState(1 / 60, radius).angleRad, true); gate('realtime-moving-weather-bypasses-stationary', false);
    const movingVelocity = await readTexture(cloudPass.resolveMaterial.uniforms.depthVelocityBuffer.value!);
    record('realtime-pass-encodes-nonzero-media-velocity', [Number(Math.hypot(...movingVelocity.slice(1, 3)) > 1e-5)], [1]);
    update(createWeatherMotionState(1 / 60, radius).angleRad, true); gate('paused-after-motion-eligible', true);
    const pausedVelocity = await readTexture(cloudPass.resolveMaterial.uniforms.depthVelocityBuffer.value!);
    record('paused-pass-clears-previous-media-velocity', pausedVelocity.slice(1, 3), [0, 0], 2e-5);
    update(0, false);
    update(0.2, false); gate('disabled-static-eligible-despite-clock', true);
    const shift = new Vector3(4096, -2048, 1024);
    worldToECEF.makeTranslation(radius + 3000 - shift.x, -shift.y, -shift.z);
    atmosphereUniforms.ecefToWorldMatrix.value.copy(worldToECEF).invert();
    cloudPass.mainCamera = cameraAt(shift);
    update(0.2, false); gate('physical-camera-rebase-still-stationary', true);

    // Unsampled Bayer pixels must change when a front clears/fills the view.
    // Use actual current-ray/resolve MRT data; never inject a history tuple.
    worldToECEF.makeTranslation(radius + 3000, 0, 0);
    atmosphereUniforms.ecefToWorldMatrix.value.copy(worldToECEF).invert();
    cloudPass.mainCamera = cameraAt(new Vector3());
    cloudPass.temporalUpscale = true;
    cloudPass.setSize(16, 16);
    frame = 0;
    const unsampled = [1, 1] as const; // Frame 1 observes (2,2) in each 4x4 block.
    for (const initiallyCloudy of [false, true]) {
      cloudPass.invalidateHistory(); frame = 0;
      occupied.value = initiallyCloudy ? 1 : 0;
      update(0, true);
      const before = await readTexture(cloudPass.outputBuffer, ...unsampled);
      occupied.value = initiallyCloudy ? 0 : 1;
      update(2e-6, true);
      const after = await readTexture(cloudPass.outputBuffer, ...unsampled);
      record(`moving-front-unsampled-${initiallyCloudy ? 'cloud-to-clear' : 'clear-to-cloud'}`,
        [Number(before[3]! > 0.1), Number(after[3]! > 0.1), Number(cloudPass.resolveMaterial.uniforms.stationaryCamera.value)],
        [Number(initiallyCloudy), Number(!initiallyCloudy), 0]);
      occupied.value = initiallyCloudy ? 1 : 0;
      cloudPass.invalidateHistory(); frame = 0;
      update(0, true);
      const stationaryBefore = await readTexture(cloudPass.outputBuffer, ...unsampled);
      occupied.value = initiallyCloudy ? 0 : 1;
      update(0, true);
      record(`paused-unsampled-retains-${initiallyCloudy ? 'cloud' : 'clear'}-control`,
        await readTexture(cloudPass.outputBuffer, ...unsampled), stationaryBefore);
    }

    // Encoder checks use a native RGBA32F target for subpixel motion precision.
    // Rebased previous/current cameras are expressed in the same local frame,
    // exactly as a host must supply them after changing its floating origin.
    const material = new CloudsMaterial(options, atmosphere);
    configureMaterial(material, resources);
    material.setSize(resources.size, resources.size);
    const pass = new ShaderPass(material);
    try {
      occupied.value = 1;
      const angle = 0.00015;
      const currentPhysical = new Vector3(radius + 3000, 0, 0);
      for (const rebase of [new Vector3(), new Vector3(4096, -2048, 1024)]) {
        worldToECEF.makeTranslation(radius + 3000 - rebase.x, -rebase.y, -rebase.z);
        atmosphereUniforms.ecefToWorldMatrix.value.copy(worldToECEF).invert();
        const currentCamera = cameraAt(rebase);
        for (const cameraTravel of [0, 80]) {
          const previousCamera = cameraAt(rebase.clone().add(new Vector3(0, -cameraTravel, 0)));
          material.copyReprojectionMatrix(previousCamera);
          material.copyCameraSettings(currentCamera);
          const u = material.uniforms;
          const label = `${rebase.lengthSq() ? 'rebased' : 'origin'}-camera-${cameraTravel}`;
          const expectedVelocity = (viewDepth: number, motionAngle: number) => {
            const point = currentPhysical.clone().add(new Vector3(-viewDepth * 10_000, 0, 0));
            point.applyMatrix3(new Matrix3().set(Math.cos(motionAngle), Math.sin(motionAngle), 0,
              -Math.sin(motionAngle), Math.cos(motionAngle), 0, 0, 0, 1));
            point.applyMatrix4(atmosphereUniforms.ecefToWorldMatrix.value);
            const previousView = point.clone().applyMatrix4(previousCamera.matrixWorldInverse);
            const ndc = point.project(previousCamera);
            return [viewDepth, -ndc.x * 0.5, -ndc.y * 0.5, -previousView.z * 1e-4];
          };
          for (const cloudy of [true, false]) {
            occupied.value = cloudy ? 1 : 0;
            const readings: number[][] = [];
            for (const moving of [false, true]) {
              u.mediaMotionEnabled.value = moving ? 1 : 0;
              u.mediaReprojectionMatrix.value.set(Math.cos(angle), Math.sin(angle), 0,
                -Math.sin(angle), Math.cos(angle), 0, 0, 0, 1);
              resources.draw(() => pass.render(renderer, null, resources.output));
              const color = await resources.readCenter();
              record(`encoder-${label}-${cloudy ? 'cloud' : 'scene'}-${moving}-branch`,
                [Number(color[3]! > 0.1), Number(color.every(Number.isFinite))], [Number(cloudy), 1]);
              const value = await readTexture(resources.output.textures[1]!);
              const expected = expectedVelocity(value[0]!, cloudy && moving ? angle : 0);
              // A physical ECEF front is quantized to half-metres in highp.
              // At this depth that allows <0.007 output pixels of error. The
              // oblique correction above produces a much larger error if it
              // is rotated with the front; the view-space clear branch can
              // retain a tighter bound because it avoids Earth-scale values.
              record(`encoder-${label}-${cloudy ? 'cloud' : 'scene'}-${moving}-velocity`, value.slice(1, 3), expected.slice(1, 3), cloudy ? 7e-4 : 2e-5);
              record(`encoder-${label}-${cloudy ? 'cloud' : 'scene'}-${moving}-previous-depth`, [value[3]!], [expected[3]!], 8e-5);
              record(`encoder-${label}-${cloudy ? 'cloud' : 'scene'}-${moving}-physical-depth`,
                cloudy ? [Number(value[0]! >= 0.1 && value[0]! <= 0.2)] : [value[0]!], cloudy ? [1] : [0.25], 1e-4);
              readings.push(value);
            }
            if (cloudy) record(`encoder-${label}-cloud-front-has-media-motion`,
              [Number(Math.hypot(...delta(readings[1]!.slice(1, 3), readings[0]!.slice(1, 3))) > 0.01)], [1]);
            else record(`encoder-${label}-scene-depth-camera-only`, readings[1]!, readings[0]!, 2e-6);
          }
        }
      }
    } finally { pass.dispose(); material.dispose(); }
  } finally {
    cloudPass.dispose(); pack.dispose(); packMaterial.dispose(); packed.dispose();
  }
}

/** Registered in runCloudConformance; explicit parent invocation only. */
export async function runCloudMotionConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance = 1e-3,
): Promise<CloudConformanceResult[]> {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Motion conformance tolerance must be finite and nonnegative');
  const cases: CloudConformanceResult[] = [];
  const record: RecordCase = (name, measured, expected, bound = tolerance) => {
    const finite = measured.length === expected.length && measured.every(Number.isFinite) && expected.every(Number.isFinite);
    const maxError = finite ? Math.max(...measured.map((v, i) => Math.abs(v - expected[i]!))) : Infinity;
    cases.push({ name: `motion-${name}`, measured, expected, maxError, passed: maxError <= bound });
  };
  await verifyField(renderer, resources, record);
  await verifyReprojection(renderer, resources, record);
  return cases;
}

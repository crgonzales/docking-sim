import { ShaderPass } from 'postprocessing';
import {
  Data3DTexture, DataTexture, FloatType, GLSL3, LinearFilter, LinearMipmapLinearFilter,
  NearestFilter, NoBlending, NoColorSpace,
  RawShaderMaterial, RGBAFormat, Uniform, UnsignedByteType, Vector3, WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { CloudMediaQuery } from './CloudBackend';
import type { CloudConformanceResult } from './CloudConformanceFixture';
import type { CloudConformanceResources } from './CloudConformanceResources';
import { VOLUMETRIC_CLOUD_PROFILES, VOLUMETRIC_CLOUD_PROFILE_TABLES, interpolateCloudProfile } from './cloudConfig';
import {
  cloudDetailNoisePositionECEFM, createWeatherBindingUniforms, createWeatherSnapshot, evaluateCloudLayerMedia,
  weatherMapLods,
  type CloudNoiseSample,
} from './cloudWeather';
import { loadCloudWeatherAssets, type CloudWeatherAssets } from './cloudWeatherAssets';
import cloudDensityGLSL from './shaders/cloudDensity.glsl?raw';

// Deliberately independent of the atmosphere configuration and its 11 km offset.
const PLANET_RADIUS_M = 6_371_000;
const ATMOSPHERE_BOTTOM_RADIUS_M = 6_360_000;
const COVERAGE = 0.625;
const NOISE: CloudNoiseSample = [0.75, 0.25, 0.5, 0.625];
const DRAW_MARKER = 7;

// Only the host ABI and output packing are fixture code. The density, profile
// interpolation, weather UVs, reference blending and filtering are canonical.
const fragmentShader = `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
const float PI = 3.141592653589793;
const float RECIPROCAL_PI = 0.3183098861837907;
const float RECIPROCAL_PI2 = 0.15915494309189535;
uniform float bottomRadius;
struct MediaSample {
  float density;
  vec4 weight;
  float scattering;
  float extinction;
  vec2 phaseAnisotropy;
  float phaseMix;
};
${cloudDensityGLSL}
uniform vec3 fixturePositionECEFM;
uniform float fixtureFootprintM;
uniform float fixtureWeatherLod;
uniform float fixtureJitter;
uniform int fixtureMode;
out vec4 fixtureOutput;
void main() {
  if (fixtureMode == 1) {
    vec2 weather = volumetricSampleWeather(fixturePositionECEFM, fixtureFootprintM, fixtureWeatherLod);
    fixtureOutput = vec4(weather, volumetricWeatherUv(fixturePositionECEFM).y, ${DRAW_MARKER}.0);
  } else if (fixtureMode == 2) {
    fixtureOutput = textureLod(volumetricWeatherNoiseTexture, fixturePositionECEFM, 0.0);
  } else {
    MediaSample media = sampleCloudMedia(
      fixturePositionECEFM, fixtureFootprintM, fixtureWeatherLod, fixtureJitter);
    // Inverse kilometres keep zero extinction/scattering from passing 1e-3.
    fixtureOutput = vec4(media.density, media.extinction * 1000.0,
      media.scattering * 1000.0, ${DRAW_MARKER}.0);
  }
}`;

function constantTexture(data: Float32Array<ArrayBuffer>): DataTexture {
  const texture = new DataTexture(data, 1, 1, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Explicit mip colours reveal which level the real weather sampler selects. */
function referenceLodProbe(dimensions: readonly number[]) {
  const mips: { data: Uint8Array<ArrayBuffer>; width: number; height: number }[] = [];
  let width = dimensions[0]!, height = dimensions[1]!;
  for (let level = 0; ; level++) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = level * 32;
      data[i + 1] = 255 - level * 32;
      data[i + 3] = 255;
    }
    mips.push({ data, width, height });
    if (width === 1 && height === 1) break;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
  const base = mips[0]!;
  const texture = new DataTexture(base.data, base.width, base.height, RGBAFormat, UnsignedByteType);
  texture.mipmaps = mips;
  texture.generateMipmaps = false;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, mips };
}

/** Base-level periodic trilinear oracle over retained, verified RGBA8 bytes. */
function sampleNoiseAtScale(
  texture: Data3DTexture, position: CloudMediaQuery['positionECEFM'], scaleM: number,
): CloudNoiseSample {
  const { data, width, height, depth } = texture.image;
  const dimensions = [width, height, depth];
  const coordinates = position.map((value, axis) => {
    // Match float coordinate representation, not the shader's noise algorithm.
    const unit = Math.fround(Math.fround(value) / Math.fround(scaleM));
    return (unit - Math.floor(unit)) * dimensions[axis]! - 0.5;
  });
  const low = coordinates.map(Math.floor);
  const fraction = coordinates.map((value, axis) => value - low[axis]!);
  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const tap = [x, y, z];
    const wrapped = tap.map((offset, axis) => {
      const size = dimensions[axis]!;
      return ((low[axis]! + offset) % size + size) % size;
    });
    const weight = tap.reduce((product, offset, axis) =>
      product * (offset ? fraction[axis]! : 1 - fraction[axis]!), 1);
    const index = ((wrapped[2]! * height + wrapped[1]!) * width + wrapped[0]!) * 4;
    for (let channel = 0; channel < 4; channel++) result[channel] += data[index + channel]! / 255 * weight;
  }
  return result;
}

function positionAt(latitudeDeg: number, longitudeDeg: number, altitudeM: number): CloudMediaQuery['positionECEFM'] {
  const latitude = latitudeDeg * Math.PI / 180;
  const longitude = longitudeDeg * Math.PI / 180;
  const radius = PLANET_RADIUS_M + altitudeM;
  return [radius * Math.cos(latitude) * Math.cos(longitude),
    radius * Math.cos(latitude) * Math.sin(longitude), radius * Math.sin(latitude)];
}

/**
 * Bounded probe-only cases; the parent owns invocation/capability checks.
 * Media tuples are [density, extinction/km, scattering/km, draw marker]. Asset
 * tuples are [coverage, type scalar, north-positive global V, draw marker].
 * Constant textures permit an independent evaluateCloudLayerMedia oracle. Real
 * weather maps use pinned source texels; noise continuity uses byte-backed
 * trilinear sampling at fixed authored scales. sampleWeatherField is reference-
 * only and is NOT treated as a CPU sampler of the global GPU weather field.
 * No renderer state scope crosses an await. Allocation/load/read errors propagate
 * to the parent; shader failures cannot pass empty cases because of the marker.
 */
export async function runCloudWeatherConformance(
  renderer: WebGLRenderer,
  resources: CloudConformanceResources,
  tolerance = 1e-3,
): Promise<CloudConformanceResult[]> {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Weather conformance tolerance must be finite and non-negative');
  const cases: CloudConformanceResult[] = [];
  const snapshot = createWeatherSnapshot({
    planetRadiusM: PLANET_RADIUS_M, visualTimeS: 0, sunDirectionECEF: [1, 0, 0],
  });
  const coverageData = new Float32Array([COVERAGE, 0, 0, 1]);
  const typeData = new Float32Array([0, 0, 0, 1]);
  const coverageTexture = constantTexture(coverageData);
  const typeTexture = constantTexture(typeData);
  const noiseTexture = new Data3DTexture(new Float32Array(NOISE), 1, 1, 1);
  noiseTexture.format = RGBAFormat;
  noiseTexture.type = FloatType;
  noiseTexture.minFilter = noiseTexture.magFilter = NearestFilter;
  noiseTexture.generateMipmaps = false;
  noiseTexture.needsUpdate = true;
  const probeUniforms = {
    bottomRadius: new Uniform(PLANET_RADIUS_M),
    fixturePositionECEFM: new Uniform(new Vector3()),
    fixtureFootprintM: new Uniform(0),
    fixtureWeatherLod: new Uniform(0),
    fixtureJitter: new Uniform(0),
    fixtureMode: new Uniform(0),
  };
  const material = new RawShaderMaterial({
    name: 'Canonical cloud weather conformance',
    glslVersion: GLSL3, depthTest: false, depthWrite: false,
    blending: NoBlending, toneMapped: false,
    uniforms: {
      ...createWeatherBindingUniforms(snapshot, {
        coverage: coverageTexture, typeField: typeTexture, noise: noiseTexture,
      }),
      ...probeUniforms,
    },
    vertexShader: `precision highp float;
      in vec3 position;
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader,
  });
  const pass = new ShaderPass(material);
  const output = new WebGLRenderTarget(1, 1, {
    type: FloatType, format: RGBAFormat, depthBuffer: false,
    minFilter: NearestFilter, magFilter: NearestFilter,
  });
  let assets: CloudWeatherAssets | undefined;
  let lodProbe: ReturnType<typeof referenceLodProbe> | undefined;
  const record = (name: string, measured: readonly number[], expected: readonly number[]) => {
    const finite = measured.length === expected.length &&
      measured.every(Number.isFinite) && expected.every(Number.isFinite);
    const maxError = finite
      ? Math.max(...measured.map((value, index) => Math.abs(value - expected[index]!))) : Infinity;
    cases.push({ name: `weather-${name}`, measured, expected, maxError, passed: finite && maxError <= tolerance });
  };
  const read = async (query: CloudMediaQuery): Promise<number[]> => {
    probeUniforms.fixturePositionECEFM.value.fromArray(query.positionECEFM);
    probeUniforms.fixtureFootprintM.value = query.footprintM;
    probeUniforms.fixtureWeatherLod.value = query.weatherLod;
    probeUniforms.fixtureJitter.value = query.jitter;
    resources.draw(() => pass.render(renderer, null, output));
    const pixel = new Float32Array(4).fill(NaN);
    // One-pixel diagnostics do not need timer-polled asynchronous readback.
    renderer.readRenderTargetPixels(output, 0, 0, 1, 1, pixel);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return Array.from(pixel);
  };
  const queryAtHeight = (altitudeM: number): CloudMediaQuery => ({
    // Axis-aligned radii and half-metre heights are exactly representable in
    // highp floats at Earth scale; thin-profile errors cannot be blamed on ECEF.
    positionECEFM: [PLANET_RADIUS_M + altitudeM, 0, 0],
    footprintM: 0, weatherLod: 0, jitter: 0.125,
  });
  const setField = (typeField: number, coverage = COVERAGE) => {
    typeData[0] = typeField;
    typeTexture.needsUpdate = true;
    coverageData[0] = coverage;
    coverageTexture.needsUpdate = true;
  };
  const expectedMedia = (
    query: CloudMediaQuery, typeField: number, coverage = COVERAGE,
    noise: CloudNoiseSample = NOISE, detailNoise: CloudNoiseSample = noise,
  ) => {
    const media = evaluateCloudLayerMedia(query, { coverage, typeField }, snapshot, noise, detailNoise);
    return [media.density, media.extinctionMInv * 1000, media.scatteringMInv * 1000, DRAW_MARKER];
  };
  try {
    // Five cases per datum. The second run must remain populated with the
    // atmosphere bottom 11 km lower: using bottomRadius in GLSL fails loudly.
    const types = [
      ...VOLUMETRIC_CLOUD_PROFILES.map((profile, index) => ({ name: profile.id, typeField: index / 3 })),
      { name: 'interpolated-deep-stratus', typeField: 0.5 },
    ];
    let interpolatedBaseline: number[] = [];
    for (const bottomRadius of [PLANET_RADIUS_M, ATMOSPHERE_BOTTOM_RADIUS_M]) {
      probeUniforms.bottomRadius.value = bottomRadius;
      for (const { name, typeField } of types) {
        const profile = interpolateCloudProfile(typeField);
        const query = queryAtHeight((profile.baseAltitudeM + profile.topAltitudeM) / 2);
        setField(typeField);
        const measured = await read(query);
        const expected = expectedMedia(query, typeField);
        if (!(expected[0]! > 0)) throw new Error(`Weather fixture ${name} requires a non-empty CPU oracle`);
        record(`${name}-midheight-atmosphere-${bottomRadius}`, measured, expected);
        if (bottomRadius === ATMOSPHERE_BOTTOM_RADIUS_M && typeField === 0.5) interpolatedBaseline = measured;
      }
    }
    const interpolated = interpolateCloudProfile(0.5);
    const middle = queryAtHeight((interpolated.baseAltitudeM + interpolated.topAltitudeM) / 2);
    // Keep the differing atmosphere datum for all remaining cases.
    const outsideMeasured: number[] = [];
    const outsideExpected: number[] = [];
    for (const altitudeM of [interpolated.baseAltitudeM - 100, interpolated.topAltitudeM + 100]) {
      const query = queryAtHeight(altitudeM);
      outsideMeasured.push(...await read(query));
      outsideExpected.push(...expectedMedia(query, 0.5));
    }
    record('below-and-above-support-empty', outsideMeasured, outsideExpected);
    const endpointMeasured: number[] = [];
    const endpointExpected: number[] = [];
    for (const altitudeM of [interpolated.baseAltitudeM, interpolated.topAltitudeM]) {
      const query = queryAtHeight(altitudeM);
      endpointMeasured.push(...await read(query));
      endpointExpected.push(...expectedMedia(query, 0.5));
    }
    record('support-endpoints-empty', endpointMeasured, endpointExpected);
    setField(0.5, 0);
    record('zero-coverage-empty', await read(middle), expectedMedia(middle, 0.5, 0));
    setField(0.5);
    const jittered = await read({ ...middle, jitter: 0.875 });
    record('jitter-invariant', [
      ...jittered, ...jittered.map((value, index) => value - interpolatedBaseline[index]!),
    ], [...expectedMedia(middle, 0.5), 0, 0, 0, 0]);
    // Positive LODs clamp to the sole constant mip; negative requests clamp to
    // zero. Both must give the same finite, non-zero canonical medium.
    const footprints = [
      { ...middle, footprintM: 250_000, weatherLod: 8 },
      { ...middle, footprintM: -100, weatherLod: -2 },
    ];
    const footprintPixels: number[] = [];
    for (const query of footprints) footprintPixels.push(...await read(query));
    record('footprint-lod-finite-constant-medium', footprintPixels,
      footprints.flatMap(query => expectedMedia(query, 0.5)));

    assets = await loadCloudWeatherAssets();
    const actualNoise = assets.textures.noise;
    if (!(actualNoise instanceof Data3DTexture)) throw new Error('Weather fixture requires the loaded 3D noise asset');
    // Preserve the uniform-map identity cached by Three after the first draw.
    Object.assign(material.uniforms, createWeatherBindingUniforms(snapshot, {
        coverage: coverageTexture, typeField: typeTexture, noise: actualNoise,
    }));
    // At a fixed 6,377,450 m ECEF position, a 0.0001 type change must blend
    // the same fixed samples in each domain. Dividing ECEF by an interpolated scale
    // instead moves the noise phase. Keep the raw-asset CPU oracle so this
    // remains sensitive to the domain fix when density authoring changes.
    const detailPosition = cloudDetailNoisePositionECEFM(middle.positionECEFM);
    const leftNoise = sampleNoiseAtScale(actualNoise, middle.positionECEFM, VOLUMETRIC_CLOUD_PROFILE_TABLES.primaryNoiseScaleM[1]);
    const rightNoise = sampleNoiseAtScale(actualNoise, middle.positionECEFM, VOLUMETRIC_CLOUD_PROFILE_TABLES.primaryNoiseScaleM[2]);
    const leftDetail = sampleNoiseAtScale(actualNoise, detailPosition, VOLUMETRIC_CLOUD_PROFILE_TABLES.detailNoiseScaleM[1]);
    const rightDetail = sampleNoiseAtScale(actualNoise, detailPosition, VOLUMETRIC_CLOUD_PROFILE_TABLES.detailNoiseScaleM[2]);
    const mixNoise = (a: CloudNoiseSample, b: CloudNoiseSample, blend: number): CloudNoiseSample => {
      const mix = (channel: number) => a[channel]! + (b[channel]! - a[channel]!) * blend;
      return [mix(0), mix(1), mix(2), mix(3)];
    };
    const continuityMeasured: number[][] = [];
    const continuityExpected: number[][] = [];
    for (const typeField of [0.5, Math.fround(0.5001)]) {
      setField(typeField);
      const blend = typeField * 3 - 1;
      const noise = mixNoise(leftNoise, rightNoise, blend);
      const detailNoise = mixNoise(leftDetail, rightDetail, blend);
      continuityMeasured.push(await read(middle));
      continuityExpected.push(expectedMedia(middle, typeField, COVERAGE, noise, detailNoise));
    }
    const withDelta = (pixels: number[][]) => [
      ...pixels.flat(), ...pixels[1]!.map((value, index) => value - pixels[0]![index]!),
    ];
    record('assets-noise-fixed-scale-type-continuity',
      withDelta(continuityMeasured), withDelta(continuityExpected));

    // Sweep the whole coverage interval: authoring may move the support edge,
    // but must retain clear support, a transition and an unchanged dense core.
    // The CPU oracle consumes both raw domains without reproducing shape math.
    // Validate hardware-filtered RGBA8 noise separately before applying the
    // steep support curve. Sub-texel filtering precision is not the CPU's
    // double-precision interpolation; the curve amplifies that small error.
    const filteredNoise = async (label: string, position: CloudMediaQuery['positionECEFM'], scale: number, expected: CloudNoiseSample) => {
      probeUniforms.fixtureMode.value = 2;
      const uv = position.map(value => {
        const unit = Math.fround(Math.fround(value) / Math.fround(scale));
        return unit - Math.floor(unit);
      }) as unknown as CloudMediaQuery['positionECEFM'];
      const measured = await read({ ...middle, positionECEFM: uv });
      record(`assets-filtered-noise-${label}`, measured, expected);
      return measured as unknown as CloudNoiseSample;
    };
    const filteredLeft = await filteredNoise('primary-left', middle.positionECEFM, VOLUMETRIC_CLOUD_PROFILE_TABLES.primaryNoiseScaleM[1], leftNoise);
    const filteredRight = await filteredNoise('primary-right', middle.positionECEFM, VOLUMETRIC_CLOUD_PROFILE_TABLES.primaryNoiseScaleM[2], rightNoise);
    const filteredDetailLeft = await filteredNoise('detail-left', detailPosition, VOLUMETRIC_CLOUD_PROFILE_TABLES.detailNoiseScaleM[1], leftDetail);
    const filteredDetailRight = await filteredNoise('detail-right', detailPosition, VOLUMETRIC_CLOUD_PROFILE_TABLES.detailNoiseScaleM[2], rightDetail);
    probeUniforms.fixtureMode.value = 0;
    const coverageNoise = mixNoise(filteredLeft, filteredRight, 0.5);
    const coverageDetail = mixNoise(filteredDetailLeft, filteredDetailRight, 0.5);
    const coverageMeasured: number[][] = [];
    const coverageExpected: number[][] = [];
    for (let step = 0; step <= 16; step++) {
      const coverage = step / 16;
      setField(0.5, coverage);
      coverageMeasured.push(await read(middle));
      coverageExpected.push(expectedMedia(middle, 0.5, coverage, coverageNoise, coverageDetail));
    }
    const densities = coverageExpected.map(pixel => pixel[0]!);
    const core = densities[densities.length - 1]!;
    if (densities[0] !== 0 || !densities.slice(1).some(value => value === 0) ||
        !densities.every((value, index) => index === 0 || value >= densities[index - 1]!) ||
        !densities.some(value => value > 0.05 * core && value < 0.95 * core) ||
        !(core > 0.5) || densities.filter(value => value === core).length < 2) {
      throw new Error(`Weather coverage fixture requires monotone clear, edge and dense-core samples: ${densities}`);
    }
    record('assets-coverage-expands-support', coverageMeasured.flat(), coverageExpected.flat());
    // An exact clear field may not hide a tiny density leak in the normal
    // CPU/GPU float tolerance. The draw marker is checked in the sweep above.
    record('assets-zero-coverage-exact',
      coverageMeasured[0]!.slice(0, 3).map(value => value === 0 ? 0 : 1), [0, 0, 0]);

    // All four real, independently owned textures and their ordinary production
    // uniforms are bound together; no texture filter/flip/row setting is changed.
    Object.assign(material.uniforms, createWeatherBindingUniforms(snapshot, assets.textures));
    probeUniforms.fixtureMode.value = 1;
    const checkAsset = async (name: string, latitude: number, longitude: number, coverageByte: number, typeByte: number) => {
      record(name, await read({ ...middle, positionECEFM: positionAt(latitude, longitude, 2200) }),
        [coverageByte / 255, typeByte / 255, latitude / 180 + 0.5, DRAW_MARKER]);
    };
    // Pinned *source* bytes, not values read from loader-reversed upload data.
    // Global north-first (x,y)=(211,102)/(211,409); identical longitude with
    // asymmetric hemispheres catches a missing/double reversal or wrong +Z axis.
    // These locations lie outside the reference patch while it stays enabled.
    await checkAsset('assets-global-north-source-texel', 53.96484375, -105.64453125, 84, 114);
    await checkAsset('assets-global-south-source-texel', -53.96484375, -105.64453125, 154, 124);
    // South-first reference (x,y)=(55,37)/(72,29)/(60,26), at texel centres
    // inside the authored isolated/deep/clear zones and outside the blend rim.
    // Their flipped rows contain [0,0], [189,91], [154,51], respectively.
    await checkAsset('assets-reference-isolated-south-first', 40.9125, -75.425, 189, 45);
    await checkAsset('assets-reference-deep-south-first', 40.3125, -74.575, 249, 112);
    await checkAsset('assets-reference-clear-gap', 40.0875, -75.175, 0, 0);

    // Exercise textureLod in the canonical sampler, not a shader-source check
    // or a diagnostic that merely prints its LOD helper. At a 20 km footprint
    // the real 128x64 local-map geometry requires LOD ≈ 2.24, while the global
    // map still requests 0. Level colours make accidental global-LOD reuse fail.
    lodProbe = referenceLodProbe(snapshot.referenceFieldAsset.dimensions);
    Object.assign(material.uniforms, createWeatherBindingUniforms(snapshot, {
      coverage: coverageTexture, typeField: typeTexture, referenceField: lodProbe.texture,
      noise: actualNoise,
    }));
    setField(0.5);
    const referenceQuery = { ...middle, positionECEFM: positionAt(40.5, -75, 2200) };
    const lastMip = lodProbe.mips.length - 1;
    for (const [name, footprintM, weatherLod] of [
      ['base', 0, 0], ['negative-clamped', -100, -2],
      ['local-footprint', 20_000, 0], ['local-footprint-bias', 20_000, 0.5],
      ['large-footprint', 100_000, 0], ['last-mip-clamped', 10_000_000, 8],
    ] as const) {
      const query = { ...referenceQuery, footprintM, weatherLod };
      const lod = Math.min(lastMip, weatherMapLods(query, snapshot).reference);
      const coverage = lod * 32 / 255;
      record(`reference-lod-${name}`, await read(query), [coverage, 1 - coverage, 40.5 / 180 + 0.5, DRAW_MARKER]);
    }
    // The reference blend's zero endpoint and points outside the patch still
    // select the unchanged global field, even under a large physical footprint.
    for (const [name, longitude] of [['boundary', snapshot.referenceBoundsDeg[0]], ['outside', -105]] as const) {
      record(`reference-lod-global-${name}`, await read({ ...referenceQuery,
        positionECEFM: positionAt(40.5, longitude, 2200), footprintM: 100_000 }),
      [COVERAGE, 0.5, 40.5 / 180 + 0.5, DRAW_MARKER]);
    }
    // A finite mip footprint may mix a real field boundary, but uniform clear
    // and full fields retain their exact endpoints at every level and bias.
    for (const value of [0, 1]) {
      for (const mip of lodProbe.mips) mip.data.fill(value * 255);
      lodProbe.texture.needsUpdate = true;
      for (const footprintM of [0, 20_000, 10_000_000]) {
        const query = { ...referenceQuery, footprintM, weatherLod: 2.5 };
        probeUniforms.fixtureMode.value = 1;
        record(`reference-lod-constant-${value}-${footprintM}`, await read(query),
          [value, value, 40.5 / 180 + 0.5, DRAW_MARKER]);
        if (value === 0) {
          probeUniforms.fixtureMode.value = 0;
          record(`reference-lod-clear-media-${footprintM}`, await read(query), [0, 0, 0, DRAW_MARKER]);
        }
      }
    }
    return cases;
  } finally {
    pass.dispose();
    material.dispose();
    output.dispose();
    coverageTexture.dispose();
    typeTexture.dispose();
    noiseTexture.dispose();
    lodProbe?.texture.dispose();
    assets?.dispose();
  }
}

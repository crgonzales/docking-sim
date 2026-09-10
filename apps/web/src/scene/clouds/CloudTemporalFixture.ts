import { ShaderPass } from 'postprocessing';
import {
  DataTexture, FloatType, GLSL3, HalfFloatType, NearestFilter, RawShaderMaterial,
  RedFormat, RGBAFormat, Uniform, WebGLRenderTarget, type WebGLRenderer,
} from 'three';
import type { CloudConformanceResult } from './CloudConformanceFixture';
import type { CloudConformanceResources } from './CloudConformanceResources';
import { CloudsResolveMaterial, bayerOffsets } from './takramCloudBackend';

type Pixel = readonly [number, number];
interface Probe { readonly output: Pixel; readonly input: Pixel }

const currentDepth = 1.25; // 12,500 positive view metres, encoded * 1e-4.
const previousDepth = 0.75; // Camera motion changes view depth, not surface identity.
const historyColor = [0.5, 0.5, 0.5, 0.5] as const;
const temporalAlpha = 0.25;

function inputTexture(width: number, height: number, channels: 1 | 4): DataTexture {
  const texture = new DataTexture(new Float32Array(width * height * channels), width, height,
    channels === 1 ? RedFormat : RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

function put(texture: DataTexture, [x, y]: Pixel, value: readonly number[]): void {
  const channels = texture.format === RedFormat ? 1 : 4;
  // Three r170's image declaration only lists byte arrays, even for FloatType.
  (texture.image.data as unknown as Float32Array).set(value, (y * texture.image.width + x) * channels);
  texture.needsUpdate = true;
}

function fill(texture: DataTexture, value: readonly number[] | ((x: number, y: number) => readonly number[])): void {
  for (let y = 0; y < texture.image.height; y++) {
    for (let x = 0; x < texture.image.width; x++) {
      put(texture, [x, y], typeof value === 'function' ? value(x, y) : value);
    }
  }
}

function get(texture: DataTexture, [x, y]: Pixel): number[] {
  const channels = texture.format === RedFormat ? 1 : 4;
  const offset = (y * texture.image.width + x) * channels;
  return Array.from((texture.image.data as unknown as Float32Array).subarray(offset, offset + channels));
}

class TemporalFixture {
  readonly width: number;
  readonly height: number;
  readonly probes: readonly Probe[];
  readonly fresh: Probe = { output: [2, 2], input: [0, 0] }; // Bayer frame 1.
  readonly color: DataTexture;
  readonly depthVelocity: DataTexture;
  readonly shadow: DataTexture;
  readonly historyColor: DataTexture;
  readonly historyDepth: DataTexture;
  readonly historyShadow: DataTexture;
  readonly material: CloudsResolveMaterial;
  private readonly resolve: ShaderPass;
  private output: WebGLRenderTarget;
  private historyOutput: WebGLRenderTarget | null = null;
  private readonly packed: WebGLRenderTarget;
  private readonly packMaterial: RawShaderMaterial;
  private readonly pack: ShaderPass;

  constructor(readonly upscale: boolean, readonly shafts: boolean, dimensions?: Pixel) {
    // Both rectangles are deliberately odd, with partial 4x4 blocks in upscale.
    this.width = dimensions?.[0] ?? (upscale ? 17 : 9);
    this.height = dimensions?.[1] ?? (upscale ? 13 : 7);
    const sourceWidth = upscale ? Math.ceil(this.width / 4) : this.width;
    const sourceHeight = upscale ? Math.ceil(this.height / 4) : this.height;
    this.probes = upscale ? [
      { output: [9, 5], input: [2, 1] },
      { output: [0, 0], input: [0, 0] },
      { output: [16, 0], input: [4, 0] },
      { output: [0, 12], input: [0, 3] },
      { output: [16, 12], input: [4, 3] },
    ] : [
      { output: [4, 3], input: [4, 3] },
      { output: [0, 0], input: [0, 0] },
      { output: [8, 0], input: [8, 0] },
      { output: [0, 6], input: [0, 6] },
      { output: [8, 6], input: [8, 6] },
    ];
    this.color = inputTexture(sourceWidth, sourceHeight, 4);
    this.depthVelocity = inputTexture(sourceWidth, sourceHeight, 4);
    this.shadow = inputTexture(sourceWidth, sourceHeight, 1);
    this.historyColor = inputTexture(this.width, this.height, 4);
    this.historyDepth = inputTexture(this.width, this.height, 1);
    this.historyShadow = inputTexture(this.width, this.height, 1);
    this.material = new CloudsResolveMaterial({
      colorBuffer: this.color, depthVelocityBuffer: this.depthVelocity,
      colorHistoryBuffer: this.historyColor, depthHistoryBuffer: this.historyDepth,
      shadowLengthBuffer: shafts ? this.shadow : null,
      shadowLengthHistoryBuffer: shafts ? this.historyShadow : null,
    });
    this.material.temporalUpscale = upscale;
    this.material.shadowLength = shafts;
    this.material.setSize(this.width, this.height);
    this.material.uniforms.frame.value = 1;
    this.material.uniforms.temporalAlpha.value = temporalAlpha;
    this.resolve = new ShaderPass(this.material);
    // Exercise the real RGBA16F / R16F / optional R16F attachment layout.
    this.output = new WebGLRenderTarget(this.width, this.height, {
      count: shafts ? 3 : 2, type: HalfFloatType, depthBuffer: false,
      minFilter: NearestFilter, magFilter: NearestFilter,
    });
    for (const attachment of this.output.textures.slice(1)) {
      attachment.format = RedFormat;
      attachment.internalFormat = 'R16F';
    }
    // Three r170 cannot select an MRT attachment in its async readback API.
    // Copy every attachment without filtering into a separate RGBA32F target.
    this.packed = new WebGLRenderTarget(this.width * 2, this.height, {
      type: FloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter,
    });
    this.packMaterial = new RawShaderMaterial({
      glslVersion: GLSL3, depthTest: false, depthWrite: false,
      uniforms: {
        color: new Uniform(this.output.textures[0]), depth: new Uniform(this.output.textures[1]),
        shadow: new Uniform(shafts ? this.output.textures[2] : this.shadow),
      },
      vertexShader: `precision highp float;
        in vec3 position;
        void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float;
        precision highp sampler2D;
        uniform sampler2D color, depth, shadow;
        out vec4 packedColor;
        void main() {
          ivec2 p = ivec2(gl_FragCoord.xy);
          int width = textureSize(color, 0).x;
          if (p.x < width) { packedColor = texelFetch(color, p, 0); }
          else {
            p.x -= width;
            packedColor = vec4(texelFetch(depth, p, 0).r,
              ${shafts ? 'texelFetch(shadow, p, 0).r' : '0.0'}, 7.0, 1.0);
          }
        }`,
    });
    this.pack = new ShaderPass(this.packMaterial);
    this.resetInputs();
  }

  resetInputs(): void {
    // A broad checkerboard neighborhood contains the distinct history values.
    // Acceptance therefore cannot be hidden by clipping to the current sample.
    fill(this.color, (x, y) => (x + y) % 2 === 0
      ? [0.125, 0.25, 0.375, 0.25] : [0.875, 0.75, 0.625, 0.875]);
    fill(this.shadow, (x, y) => [(x + y) % 2 === 0 ? 0.25 : 1.75]);
    fill(this.depthVelocity, [currentDepth, 0, 0, previousDepth]);
    fill(this.historyColor, historyColor);
    fill(this.historyDepth, [previousDepth]);
    fill(this.historyShadow, [1]);
  }

  current(probe: Probe, depth = currentDepth): number[] {
    if (!this.upscale) return [...get(this.color, probe.input), depth,
      ...(this.shafts ? get(this.shadow, probe.input) : [])];
    // Independent bilinear oracle on the known current-ray lattice. Fresh
    // Bayer pixels land exactly on a texel; odd viewport edges clamp.
    const offset = bayerOffsets[this.material.uniforms.frame.value % 16]!;
    const px = (probe.output[0] - Math.floor(offset.x * 4)) / 4;
    const py = (probe.output[1] - Math.floor(offset.y * 4)) / 4;
    const color = [0, 0, 0, 0];
    let shadow = 0;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const weight = (x ? px - Math.floor(px) : 1 - (px - Math.floor(px))) *
        (y ? py - Math.floor(py) : 1 - (py - Math.floor(py)));
      const tap: Pixel = [Math.max(0, Math.min(this.color.image.width - 1, Math.floor(px) + x)),
        Math.max(0, Math.min(this.color.image.height - 1, Math.floor(py) + y))];
      get(this.color, tap).forEach((value, i) => { color[i]! += weight * value; });
      shadow += weight * get(this.shadow, tap)[0]!;
    }
    return [...color, depth, ...(this.shafts ? [shadow] : [])];
  }

  accepted(probe: Probe, alpha = this.upscale ? 0 : temporalAlpha): number[] {
    const current = this.current(probe);
    return [
      ...historyColor.map((value, i) => value * (1 - alpha) + current[i]! * alpha),
      currentDepth,
      ...(this.shafts ? [1 * (1 - alpha) + current[5]! * alpha] : []),
    ];
  }

  render(renderer: WebGLRenderer, resources: CloudConformanceResources): void {
    resources.draw(() => this.resolve.render(renderer, null, this.output));
  }

  async read(renderer: WebGLRenderer, resources: CloudConformanceResources): Promise<Float32Array> {
    this.packMaterial.uniforms.color.value = this.output.textures[0];
    this.packMaterial.uniforms.depth.value = this.output.textures[1];
    this.packMaterial.uniforms.shadow.value = this.shafts ? this.output.textures[2] : this.shadow;
    resources.draw(() => {
      this.resolve.render(renderer, null, this.output);
      this.pack.render(renderer, null, this.packed);
    });
    // Tiny diagnostic target: synchronous readback avoids background-tab timer
    // throttling in Three's fence polling. This never runs in the flight path.
    const pixels = new Float32Array(this.width * 2 * this.height * 4).fill(NaN);
    renderer.readRenderTargetPixels(this.packed, 0, 0, this.width * 2, this.height, pixels);
    // Give the browser a frame between batches, rather than queueing the whole
    // suite's shader compilation and draws in one uninterrupted microtask run.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return pixels;
  }

  advanceHistory(): void {
    const next = this.historyOutput ?? this.output.clone();
    this.historyOutput = this.output;
    this.output = next;
    const u = this.material.uniforms;
    u.colorHistoryBuffer.value = this.historyOutput.textures[0];
    u.depthHistoryBuffer.value = this.historyOutput.textures[1];
    u.shadowLengthHistoryBuffer.value = this.shafts ? this.historyOutput.textures[2] : null;
    u.historyValid.value = true;
  }

  measured(pixels: Float32Array, { output: [x, y] }: Probe): number[] {
    const color = (y * this.width * 2 + x) * 4;
    const metadata = color + this.width * 4;
    // A missing/failed packing draw must not pass a clear/zero-depth case.
    if (pixels[metadata + 2] !== 7 || pixels[metadata + 3] !== 1) {
      return Array(this.shafts ? 6 : 5).fill(NaN);
    }
    return [...pixels.subarray(color, color + 4), pixels[metadata]!,
      ...(this.shafts ? [pixels[metadata + 1]!] : [])];
  }

  dispose(): void {
    this.resolve.dispose();
    this.pack.dispose();
    this.material.dispose();
    this.packMaterial.dispose();
    this.output.dispose();
    this.historyOutput?.dispose();
    this.packed.dispose();
    for (const texture of [this.color, this.depthVelocity, this.shadow,
      this.historyColor, this.historyDepth, this.historyShadow]) texture.dispose();
  }
}

/**
 * Probe-only GPU cases for the production resolve material. The parent owns
 * capability reporting and invocation; no CloudsPass lifecycle/encoder is mocked.
 * Measurements are RGBA, encoded current view depth, then shafts when enabled.
 * Throws on allocation/readback errors; the parent runner reports those failures.
 */
export async function runCloudTemporalConformance(
  renderer: WebGLRenderer,
  resources: CloudConformanceResources,
  tolerance = 1e-3,
): Promise<CloudConformanceResult[]> {
  const cases: CloudConformanceResult[] = [];
  for (const upscale of [false, true]) {
    for (const shafts of [false, true]) {
      const fixture = new TemporalFixture(upscale, shafts);
      const u = fixture.material.uniforms;
      const prefix = `temporal-${upscale ? 'upscale' : 'native'}-shafts-${shafts ? 'on' : 'off'}`;
      const center = fixture.probes[0]!;
      const check = async (name: string, expected: (probe: Probe) => number[], probes = [center]) => {
        const pixels = await fixture.read(renderer, resources);
        const measured = probes.flatMap(probe => fixture.measured(pixels, probe));
        const wanted = probes.flatMap(expected);
        const finite = measured.length === wanted.length && measured.every(Number.isFinite);
        const maxError = finite ? Math.max(...measured.map((value, i) => Math.abs(value - wanted[i]!))) : Infinity;
        cases.push({ name: `${prefix}-${name}`, measured, expected: wanted, maxError,
          passed: finite && maxError <= tolerance });
      };
      const current = (probe: Probe) => fixture.current(probe);
      const accepted = (probe: Probe) => fixture.accepted(probe);
      const reset = () => {
        fixture.resetInputs();
        u.historyValid.value = u.historyEnabled.value = true;
        u.accumulateFreshSamples.value = false;
      };
      try {
        // Leave the constructor's historyValid untouched: this is the first draw.
        await check('first-frame-odd-edges', current, [...fixture.probes]);
        reset();
        u.historyEnabled.value = false;
        await check('disabled-history-reference', current);
        reset();
        await check('valid-history-odd-edges', accepted, [...fixture.probes]);

        if (upscale) {
          await check('fresh-bayer-current', current, [fixture.fresh]);
          u.accumulateFreshSamples.value = true;
          await check('fresh-bayer-accumulation', probe => fixture.accepted(probe, temporalAlpha), [fixture.fresh]);
        }

        reset();
        // History at today's depth is a different surface: expected previous
        // depth in A, rather than current depth in R, must validate reprojection.
        fill(fixture.historyDepth, [currentDepth]);
        await check('depth-disocclusion-rejects', current);

        for (const [name, depth] of [
          ['behind-camera', -previousDepth], ['zero-previous-depth', 0],
          ['nan-previous-depth', NaN], ['infinite-previous-depth', Infinity],
        ] as const) {
          reset();
          fill(fixture.depthVelocity, [currentDepth, 0, 0, depth]);
          await check(`${name}-rejects`, current);
        }

        for (const [name, vx, vy] of [
          ['left', 2, 0], ['right', -2, 0], ['bottom', 0, 2], ['top', 0, -2],
        ] as const) {
          reset();
          fill(fixture.depthVelocity, [currentDepth, vx, vy, previousDepth]);
          await check(`offscreen-${name}-rejects`, current);
        }

        reset();
        fill(fixture.historyColor, [0, 0, 0, 0]);
        await check('history-clear-gap-rejects', current);
        reset();
        // A freshly measured clear ray must erase history immediately. An
        // unsampled pixel instead uses its own spatial/history reconstruction.
        const clearProbe = upscale ? fixture.fresh : center;
        put(fixture.color, clearProbe.input, [0, 0, 0, 0]);
        await check('current-clear-gap-zero-depth', probe => fixture.current(probe, 0), [clearProbe]);
        reset();
        fill(fixture.depthVelocity, [0, 0, 0, previousDepth]);
        await check('invalid-current-zero-depth', probe => fixture.current(probe, 0));

        // Reproject half a texel in both axes. Four deliberately different
        // samples average to the known history tuple (0.5 RGBA, 1 shaft).
        reset();
        fill(fixture.depthVelocity, [currentDepth, -0.5 / fixture.width, -0.5 / fixture.height, previousDepth]);
        const [x, y] = center.output;
        const taps: Pixel[] = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
        for (const [i, value] of [0.25, 0.375, 0.625, 0.75].entries()) {
          put(fixture.historyColor, taps[i]!, [value, value, value, value]);
          put(fixture.historyShadow, taps[i]!, [value * 2]);
        }
        await check('bilinear-matched-tuple', accepted);
        // The base/nearest tap remains valid; another contributing surface
        // must invalidate color and shafts together, regardless of filtering.
        put(fixture.historyDepth, taps[3]!, [currentDepth]);
        await check('bilinear-disoccluded-tap-rejects', current);
        put(fixture.historyDepth, taps[3]!, [previousDepth]);
        put(fixture.historyColor, taps[3]!, [0, 0, 0, 0]);
        await check('bilinear-clear-tap-rejects', current);
      } finally {
        fixture.dispose();
      }
    }
  }
  cases.push(...await runCloudBayerReconstructionConformance(renderer, resources, tolerance));
  cases.push(...await runCloudSpatialReconstructionConformance(renderer, resources, tolerance));
  cases.push(...await runCloudStationarySamplingConformance(renderer, resources, tolerance));
  cases.push(...await runCloudStationarySamplingConformance(renderer, resources, tolerance, 800));
  return cases;
}

/** Eight noisy observations at an actual cloud/gap edge, using real MRT history.
 * Bayer runs all 128 phases; native TAA observes the ray on each of eight frames. */
async function runCloudStationarySamplingConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance: number,
  stationaryDepthM = 0,
): Promise<CloudConformanceResult[]> {
  const cases: CloudConformanceResult[] = [];
  for (const upscale of [false, true]) for (const shafts of [false, true]) {
    const fixture = new TemporalFixture(upscale, shafts);
    const u = fixture.material.uniforms;
    const probe = upscale ? fixture.fresh : fixture.probes[0]!;
    const [px, py] = probe.output;
    const record = (name: string, measured: number[], expected: number[]) => {
      const maxError = measured.every(Number.isFinite)
        ? Math.max(...measured.map((value, i) => Math.abs(value - expected[i]!))) : Infinity;
      const bound = stationaryDepthM > 0 ? `-depth-${stationaryDepthM}m` : '';
      cases.push({ name: `temporal-stationary-${upscale ? 'bayer' : 'native'}-shafts-${shafts}${bound}-${name}`,
        measured, expected, maxError, passed: maxError <= tolerance });
    };
    const checkCurrent = async (name: string, depth: number) => record(name,
      fixture.measured(await fixture.read(renderer, resources), probe), fixture.current(probe, depth));
    try {
      u.stationaryCamera.value = u.accumulateFreshSamples.value = true;
      if (stationaryDepthM > 0) u.stationaryDepthAbsoluteThresholdM.value = stationaryDepthM;
      const meanDepth = stationaryDepthM > 0 ? 2 : 0.75;
      const depthNoise = stationaryDepthM > 0 ? 0.03125 : 0.001;
      const lastDepth = meanDepth - depthNoise;
      let lastSample: number[] = [];
      let peak = 0;
      for (let frame = 0; frame < (upscale ? 128 : 8); frame++) {
        u.frame.value = frame + (upscale ? 1 : 0); // Begin on this ray's first fresh observation.
        const observation = Math.floor(frame / (upscale ? 16 : 1));
        const noise = observation % 2 ? -0.125 : 0.125;
        // Default: 20 m peak-to-peak. Opt-in: 625 m at 20 km, beyond the
        // strict 200 m relative guard but inside the configured 800 m budget.
        const depth = meanDepth + (observation % 2 ? -depthNoise : depthNoise);
        const offset = bayerOffsets[u.frame.value % 16]!;
        const dx = upscale ? Math.floor(offset.x * 4) : 0, dy = upscale ? Math.floor(offset.y * 4) : 0;
        for (let y = 0; y < fixture.color.image.height; y++) for (let x = 0; x < fixture.color.image.width; x++) {
          const wx = upscale ? 4 * x + dx : x, wy = upscale ? 4 * y + dy : y;
          const cloudy = wx <= px;
          const value = wy === py ? 0.5 + noise : wy < py ? 0.125 : 0.875;
          setRay(fixture, [x, y], cloudy ? [value, value, value, 0.75, depth, 1] : [0, 0, 0, 0, 0, 0]);
          // A 0.0001-pixel numerical motion adds a clear neighbor to bilinear history.
          put(fixture.depthVelocity, [x, y], [cloudy ? depth : 0, -1e-4 / fixture.width, 0, cloudy ? depth : 0]);
        }
        const fresh = !upscale || (px % 4 === dx && py % 4 === dy);
        // Execute every real GPU history step, but only cross the GPU/CPU
        // boundary for measured observations and the final retained tuple.
        // Background-tab timer throttling makes unused readbacks very costly.
        if ((fresh && observation >= 6) || frame === (upscale ? 127 : 7)) {
          lastSample = fixture.measured(await fixture.read(renderer, resources), probe);
        } else {
          fixture.render(renderer, resources);
        }
        if (fresh && observation >= 6) {
          for (const value of lastSample.slice(0, 3)) peak = Math.max(peak, Math.abs(value - 0.5));
        }
        fixture.advanceHistory();
      }
      // Raw noise peaks at 0.125; require at least 68% reduction after eight
      // observations. Report excess over the bound, not a CPU filter replica.
      record('excess-noise-above-0.04', [Math.max(0, peak - 0.04)], [0]);
      u.frame.value = 1; // Fresh Bayer ray at (2,2), so all guards exercise accumulation.
      fill(fixture.color, (x, y) => {
        const value = (x + y) % 2 ? 0.875 : 0.125;
        return [value, value, value, 0.75];
      });
      fill(fixture.shadow, [1]);
      fill(fixture.depthVelocity, [1.5, 0, 0, 1.5]);
      await checkCurrent('same-pixel-disocclusion-rejects', 1.5);
      if (stationaryDepthM > 0) {
        const within = lastDepth + 0.078125; // 781.25 m; exact in R16F.
        fill(fixture.depthVelocity, [within, 0, 0, within]);
        const current = fixture.current(probe, within);
        record('within-bound-accumulates-matched-tuple',
          fixture.measured(await fixture.read(renderer, resources), probe),
          current.map((value, i) => i === 4 ? value : value * temporalAlpha + lastSample[i]! * (1 - temporalAlpha)));
        for (const [name, bound] of [['disabled', 0], ['nan', NaN], ['infinite', Infinity]] as const) {
          u.stationaryDepthAbsoluteThresholdM.value = bound;
          await checkCurrent(`${name}-uncertainty-keeps-strict-guard`, within);
        }
        u.stationaryDepthAbsoluteThresholdM.value = stationaryDepthM;
        const foreground = lastDepth - 0.09375; // 937.5 m nearer, beyond budget.
        fill(fixture.depthVelocity, [foreground, 0, 0, foreground]);
        await checkCurrent('foreground-beyond-bound-rejects', foreground);
        u.stationaryCamera.value = false;
        // Reproject into a fully cloudy interior, so only depth can reject;
        // no clear bilinear tap can hide an accidentally broadened motion guard.
        fill(fixture.depthVelocity, [within, (px - 1) / fixture.width, 0, within]);
        await checkCurrent('motion-keeps-strict-depth-guard', within);
        u.stationaryCamera.value = true;
      }
      fill(fixture.depthVelocity, [lastDepth, -1e-4 / fixture.width, 0, lastDepth]);
      u.stationaryCamera.value = false;
      await checkCurrent('moving-clear-tap-still-rejects', lastDepth);
      u.stationaryCamera.value = true;
      u.historyValid.value = false;
      await checkCurrent('cut-bypasses-accumulation', lastDepth);
      u.historyValid.value = true;
      fill(fixture.color, [0, 0, 0, 0]);
      await checkCurrent('fresh-clear-erases-history', 0);
    } finally { fixture.dispose(); }
  }
  return cases;
}

// A high-resolution scene description, independent of temporal reconstruction:
// sub-block gaps, a small hole, dense colored clouds, and multiple view depths.
function maskSample(x: number, y: number, changed = false): number[] {
  const gap = x % 4 === 1 || y % 4 === 2 || (x - 8) ** 2 + (y - 6) ** 2 < 5;
  const clear = changed && x % 4 !== 0 ? !gap : gap;
  if (clear) return [0, 0, 0, 0, 0, 0.125];
  const r = 0.125 + (x % 3) * 0.125, g = 0.125 + (y % 3) * 0.125;
  const b = 0.125 + ((x + y) % 3) * 0.0625;
  return [changed ? 0.625 - r : r, changed ? 0.625 - g : g,
    changed ? 0.5 - b : b, changed ? 0.875 : 0.75,
    0.5 + (x % 3) * 0.25 + (y % 2) * 0.125 + (changed ? 2 : 0),
    0.25 + ((x + 2 * y) % 5) * 0.125];
}

function setRay(fixture: TemporalFixture, pixel: Pixel, sample: readonly number[]): void {
  put(fixture.color, pixel, sample.slice(0, 4));
  put(fixture.depthVelocity, pixel, [sample[4]!, 0, 0, sample[4]!]);
  put(fixture.shadow, pixel, [sample[5]!]);
}

/**
 * Real ping-pong MRT history over 64 Bayer frames per shaft mode. Compares every
 * pixel/attachment to a native resolve of a known scene, with no CPU resolve or
 * readback-to-history upload. Cases report maximum errors per RGBA/depth/shaft.
 * Included by runCloudTemporalConformance; may also be invoked alone.
 */
export async function runCloudBayerReconstructionConformance(
  renderer: WebGLRenderer,
  resources: CloudConformanceResources,
  tolerance = 1e-3,
): Promise<CloudConformanceResult[]> {
  const cases: CloudConformanceResult[] = [];
  for (const shafts of [false, true]) {
    const fixture = new TemporalFixture(true, shafts);
    const native = new TemporalFixture(false, shafts, [fixture.width, fixture.height]);
    const u = fixture.material.uniforms;
    const probes: Probe[] = [];
    for (let y = 0; y < fixture.height; y++) {
      for (let x = 0; x < fixture.width; x++) probes.push({ output: [x, y], input: [x, y] });
    }
    const channels = shafts ? 6 : 5;
    const zeros = () => Array<number>(channels).fill(0);
    const record = (name: string, errors: number[]) => {
      const finite = errors.every(Number.isFinite);
      const maxError = finite ? Math.max(...errors) : Infinity;
      cases.push({ name: `temporal-bayer-cycle-shafts-${shafts ? 'on' : 'off'}-${name}`,
        measured: errors, expected: zeros(), maxError, passed: finite && maxError <= tolerance });
    };
    const errors = (pixels: Float32Array, truth: readonly number[][], selected = probes) => {
      const result = zeros();
      for (const probe of selected) {
        const actual = fixture.measured(pixels, probe);
        const expected = truth[probe.output[1] * fixture.width + probe.output[0]]!;
        for (let i = 0; i < channels; i++) {
          const delta = Math.abs(actual[i]! - expected[i]!);
          result[i] = Math.max(result[i]!, Number.isFinite(delta) ? delta : Infinity);
        }
      }
      return result;
    };
    const merge = (into: number[], next: number[]) => next.forEach((value, i) => { into[i] = Math.max(into[i]!, value); });
    const nativeTruth = async (changed: boolean) => {
      for (const { output: [x, y] } of probes) setRay(native, [x, y], maskSample(x, y, changed));
      native.material.uniforms.historyEnabled.value = false;
      const pixels = await native.read(renderer, resources);
      record(changed ? 'changed-native-oracle' : 'native-oracle',
        errors(pixels, probes.map(({ output: [x, y] }) => maskSample(x, y, changed))));
      return probes.map(probe => native.measured(pixels, probe));
    };
    const freshErrors = zeros();
    const step = async (frame: number, changed: boolean, truth: number[][]) => {
      const offset = bayerOffsets[frame % 16]!;
      const dx = Math.floor(offset.x * 4), dy = Math.floor(offset.y * 4);
      // Sample the actual producer's Bayer offsets, including rays in the
      // padded part of odd viewports. Those rays must not erase valid edges.
      for (let y = 0; y < fixture.color.image.height; y++) {
        for (let x = 0; x < fixture.color.image.width; x++) {
          setRay(fixture, [x, y], maskSample(x * 4 + dx, y * 4 + dy, changed));
        }
      }
      u.frame.value = frame;
      u.stationaryCamera.value = frame > 0;
      const pixels = await fixture.read(renderer, resources);
      merge(freshErrors, errors(pixels, truth,
        probes.filter(({ output: [x, y] }) => x % 4 === dx && y % 4 === dy)));
      fixture.advanceHistory();
      return pixels;
    };
    try {
      const truth = await nativeTruth(false);
      let pixels: Float32Array = new Float32Array();
      for (let frame = 0; frame < 16; frame++) pixels = await step(frame, false, truth);
      record('first-cycle-matches-native', errors(pixels, truth));
      const settledErrors = zeros();
      for (let frame = 16; frame < 32; frame++) {
        pixels = await step(frame, false, truth);
        merge(settledErrors, errors(pixels, truth));
      }
      record('second-cycle-stays-native', settledErrors);

      // Change gaps AND depth without a cut. Unsampled positions have no new
      // evidence; every newly measured ray must reject its old surface/gap,
      // even with fresh accumulation enabled, and all pixels recover in 16.
      const changedTruth = await nativeTruth(true);
      u.accumulateFreshSamples.value = true;
      for (let frame = 32; frame < 48; frame++) pixels = await step(frame, true, changedTruth);
      record('changed-media-recovers-within-cycle', errors(pixels, changedTruth));

      const guardSample = [0.25, 0.375, 0.5, 0.75, 5, 0.5];
      const guardTruth = probes.map(() => guardSample);
      for (let y = 0; y < fixture.color.image.height; y++) {
        for (let x = 0; x < fixture.color.image.width; x++) setRay(fixture, [x, y], guardSample);
      }
      u.frame.value = 48;
      u.stationaryCamera.value = false;
      record('moving-view-depth-rejects', errors(await fixture.read(renderer, resources), guardTruth));
      u.stationaryCamera.value = true;
      fill(fixture.depthVelocity, [5, 0, 0, -5]);
      record('behind-camera-still-rejects', errors(await fixture.read(renderer, resources), guardTruth));
      fill(fixture.depthVelocity, [5, 2, 0, 5]);
      record('offscreen-still-rejects', errors(await fixture.read(renderer, resources), guardTruth));
      fill(fixture.depthVelocity, [5, 0, 0, 5]);
      u.historyEnabled.value = false;
      record('disabled-history-bypasses-preservation', errors(await fixture.read(renderer, resources), guardTruth));

      u.historyEnabled.value = true;
      u.historyValid.value = false;
      u.accumulateFreshSamples.value = false;
      fill(fixture.color, [0, 0, 0, 0]);
      fill(fixture.depthVelocity, [0, 0, 0, 0]);
      fill(fixture.shadow, [0.125]);
      record('cut-discards-entire-history', errors(await fixture.read(renderer, resources),
        probes.map(() => [0, 0, 0, 0, 0, 0.125])));
      fixture.advanceHistory();
      for (let frame = 49; frame < 65; frame++) pixels = await step(frame, false, truth);
      record('post-cut-recovers-within-cycle', errors(pixels, truth));
      record('fresh-rays-match-native-throughout', freshErrors);
    } finally {
      fixture.dispose();
      native.dispose();
    }
  }
  return cases;
}

/** Linear fields have an exact reconstruction independent of any resolver.
 * Exercise all Bayer phases during motion and invalid history, plus a gap edge
 * whose intermediate pixels must not repeat the block's current clear ray. */
async function runCloudSpatialReconstructionConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance: number,
): Promise<CloudConformanceResult[]> {
  const cases: CloudConformanceResult[] = [];
  for (const shafts of [false, true]) {
    const fixture = new TemporalFixture(true, shafts);
    const u = fixture.material.uniforms;
    const channels = shafts ? 6 : 5;
    const record = (name: string, errors: number[]) => {
      const maxError = errors.every(Number.isFinite) ? Math.max(...errors) : Infinity;
      cases.push({ name: `temporal-spatial-shafts-${shafts ? 'on' : 'off'}-${name}`,
        measured: errors, expected: Array(channels).fill(0), maxError,
        passed: maxError <= tolerance });
    };
    const compare = (errors: number[], pixels: Float32Array, x: number, y: number, truth: number[]) => {
      const actual = fixture.measured(pixels, { output: [x, y], input: [0, 0] });
      for (let c = 0; c < channels; c++) errors[c] = Math.max(errors[c]!, Math.abs(actual[c]! - truth[c]!));
    };
    const plane = (x: number, y: number) =>
      [0.02 * (x + 1), 0.025 * (y + 1), 0.1 + 0.003 * x + 0.005 * y, 0.6, 1, 0.1 + 0.02 * x];
    try {
      u.stationaryCamera.value = false;
      u.historyEnabled.value = true;
      fill(fixture.historyDepth, [5]); // A different surface must reject.
      for (const valid of [false, true]) {
        u.historyValid.value = valid;
        const errors = Array(channels).fill(0);
        for (let frame = 0; frame < 16; frame++) {
          u.frame.value = frame;
          const offset = bayerOffsets[frame]!;
          const dx = Math.floor(offset.x * 4), dy = Math.floor(offset.y * 4);
          for (let y = 0; y < fixture.color.image.height; y++) {
            for (let x = 0; x < fixture.color.image.width; x++) {
              setRay(fixture, [x, y], plane(x * 4 + dx, y * 4 + dy));
              put(fixture.depthVelocity, [x, y], [1, 0.5 / fixture.width, 0, 1]);
            }
          }
          const pixels = await fixture.read(renderer, resources);
          for (let y = 4; y <= 8; y++) for (let x = 4; x <= 12; x++) {
            compare(errors, pixels, x, y, plane(x, y));
          }
        }
        record(valid ? 'moving-disocclusion-linear-field' : 'cut-linear-field', errors);
      }
      u.frame.value = 0; // Rays at x=4 and x=8 bracket this cloud edge.
      for (let y = 0; y < fixture.color.image.height; y++) {
        for (let x = 0; x < fixture.color.image.width; x++) {
          setRay(fixture, [x, y], x <= 1 ? [0, 0, 0, 0, 0, 0] : [0.5, 0.25, 0.125, 0.5, 1, 0.5]);
        }
      }
      for (const valid of [false, true]) {
        u.historyValid.value = valid;
        const pixels = await fixture.read(renderer, resources);
        const errors = Array(channels).fill(0);
        for (let x = 4; x <= 8; x++) {
          const t = (x - 4) / 4;
          compare(errors, pixels, x, 5, [0.5 * t, 0.25 * t, 0.125 * t, 0.5 * t, t > 0 ? 1 : 0, 0.5 * t]);
        }
        record(valid ? 'moving-gap-edge' : 'cut-gap-edge', errors);
      }
    } finally { fixture.dispose(); }
  }
  return cases;
}

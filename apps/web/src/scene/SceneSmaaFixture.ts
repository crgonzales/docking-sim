import { EffectPass, ShaderPass, SMAAEffect, SMAAPreset } from 'postprocessing';
import { Color, FloatType, HalfFloatType, NoToneMapping, PerspectiveCamera, ShaderMaterial,
  SRGBColorSpace, Uniform, Vector2, Vector4, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { createSceneSmaa, onSceneSmaaLoad, sceneSmaaReady } from './librarySmaa';

const vertexShader = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
const pixel = (buffer: Float32Array, width: number, x: number, y: number) =>
  Array.from(buffer.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));

function sample(buffer: Float32Array, width: number, height: number, x: number, y: number): number[] {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const result = [0, 0, 0, 0];
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const p = pixel(buffer, width, Math.max(0, Math.min(width - 1, ix + dx)), Math.max(0, Math.min(height - 1, iy + dy)));
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    p.forEach((v, c) => { result[c] += v * weight; });
  }
  return result;
}

/** Independent CPU oracle for the installed SMAA neighborhood blend. Inputs
 * are real GPU color/weight readbacks, with the original half-float rounding.
 */
export function sceneSmaaLinearBlend(input: Float32Array, weights: Float32Array,
  width: number, height: number, x: number, y: number): number[] {
  const center = pixel(weights, width, x, y);
  const right = pixel(weights, width, Math.min(width - 1, x + 1), y)[3];
  const top = pixel(weights, width, x, Math.min(height - 1, y + 1))[1];
  if (right + top + center[0] + center[2] < 1e-5) return pixel(input, width, x, y);
  const horizontal = Math.max(right, center[2]) > Math.max(top, center[0]);
  const positive = horizontal ? right : top, negative = horizontal ? center[2] : center[0];
  const a = sample(input, width, height, x + (horizontal ? positive : 0), y + (horizontal ? 0 : positive));
  const b = sample(input, width, height, x - (horizontal ? negative : 0), y - (horizontal ? 0 : negative));
  return a.map((v, c) => (v * positive + b[c] * negative) / (positive + negative));
}

export interface SceneSmaaEvidence {
  name: string;
  size: readonly [number, number];
  edgePixels: number;
  weightPixels: number;
  changedPixels: number;
  maxLinearBlendError: number;
  maxFlatError: number;
  edgeSample: { xy: number[]; value: number[] } | null;
  weightSample: { xy: number[]; value: number[] } | null;
  samples: { xy: number[]; input: number[]; edge: number[]; weight: number[];
    output: number[]; expectedLinear: number[] }[];
  passed: boolean;
}

function measure(name: string, width: number, height: number, input: Float32Array,
  edge: Float32Array, weights: Float32Array, output: Float32Array): SceneSmaaEvidence {
  const result: SceneSmaaEvidence = { name, size: [width, height], edgePixels: 0, weightPixels: 0,
    changedPixels: 0, maxLinearBlendError: 0, maxFlatError: 0, edgeSample: null, weightSample: null, samples: [], passed: false };
  const difference = (a: number[], b: number[]) => Math.max(...a.map((v, c) => Math.abs(v - b[c])));
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const i = pixel(input, width, x, y), e = pixel(edge, width, x, y);
    const w = pixel(weights, width, x, y), o = pixel(output, width, x, y);
    const expectedLinear = sceneSmaaLinearBlend(input, weights, width, height, x, y);
    if (Math.max(e[0], e[1]) > 0.5) {
      result.edgePixels++; result.edgeSample ??= { xy: [x, y], value: e };
    }
    if (Math.max(...w) > 0) {
      result.weightPixels++; result.weightSample ??= { xy: [x, y], value: w };
    }
    const changed = difference(o, i) > 2e-4;
    if (changed) result.changedPixels++;
    result.maxLinearBlendError = Math.max(result.maxLinearBlendError, difference(o, expectedLinear));
    if (changed && result.samples.length < 8) result.samples.push({ xy: [x, y], input: i,
      edge: e, weight: w, output: o, expectedLinear });
  }
  // Flat colors must remain linear; encoding the entire image would fail here.
  for (const x of [2, width - 3]) result.maxFlatError = Math.max(result.maxFlatError,
    difference(pixel(input, width, x, 2), pixel(output, width, x, 2)));
  const fixed = name === 'perceptual-high';
  result.passed = result.maxLinearBlendError < 5e-4 && result.maxFlatError < 5e-4 &&
    (fixed ? result.edgePixels > 0 && result.weightPixels > 0 && result.changedPixels > 0
      : result.edgePixels === 0 && result.weightPixels === 0 && result.changedPixels === 0);
  return result;
}

async function waitForLookups(effect: SMAAEffect): Promise<void> {
  if (sceneSmaaReady(effect)) return;
  await new Promise<void>((resolve, reject) => {
    const loaded = () => { clearTimeout(timeout); removeLoad(); resolve(); };
    const timeout = setTimeout(() => {
      removeLoad(); reject(new Error('SMAA lookup images did not load'));
    }, 10000);
    const removeLoad = onSceneSmaaLoad(effect, loaded);
  });
}

/** Deferred manual GPU fixture. Import from the existing probe and call
 * runSceneSmaaFixture(renderer) AFTER gameplay QA. It does not mount anything,
 * render to screen, resize the canvas, use cloud assets, or create a context.
 * Four tiny draws/readback cases; all targets are <=45x35, LUTs <1 MB total.
 * No renderer state is held across an await. Returns measured edges, weights,
 * changed pixels and an independent linear-blend check, not shader-text claims.
 */
export async function runSceneSmaaFixture(renderer: WebGLRenderer): Promise<{ passed: boolean; cases: SceneSmaaEvidence[] }> {
  const stock = new SMAAEffect({ preset: SMAAPreset.HIGH }), fixed = createSceneSmaa('high');
  const camera = new PerspectiveCamera();
  const passes = [new EffectPass(camera, stock), new EffectPass(camera, fixed)];
  const sourceMaterial = new ShaderMaterial({
    uniforms: {
      size: new Uniform(new Vector2()),
      dark: new Uniform(new Color().setRGB(3 / 255, 3 / 255, 11 / 255, SRGBColorSpace)),
      ocean: new Uniform(new Color().setRGB(33 / 255, 44 / 255, 72 / 255, SRGBColorSpace)),
    },
    vertexShader, fragmentShader: `uniform vec2 size; uniform vec3 dark; uniform vec3 ocean;
      void main() {
        float edge = floor(size.x * 0.3 + gl_FragCoord.y * 0.5);
        gl_FragColor = vec4(gl_FragCoord.x < edge ? dark : ocean, 1.0);
      }`,
    toneMapped: false, depthTest: false, depthWrite: false,
  });
  const source = new ShaderPass(sourceMaterial);
  const copyMaterial = new ShaderMaterial({ uniforms: { map: new Uniform(null), size: new Uniform(new Vector2()) },
    vertexShader, fragmentShader: 'uniform sampler2D map; uniform vec2 size; void main() { gl_FragColor = texture2D(map, gl_FragCoord.xy / size); }',
    toneMapped: false, depthTest: false, depthWrite: false,
  });
  const copy = new ShaderPass(copyMaterial);
  const input = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  const output = new WebGLRenderTarget(1, 1, { type: FloatType, depthBuffer: false });
  const readback = new WebGLRenderTarget(1, 1, { type: FloatType, depthBuffer: false });
  const cases: SceneSmaaEvidence[] = [];
  try {
    await Promise.all([waitForLookups(stock), waitForLookups(fixed)]);
    const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getViewport(new Vector4()), scissor = renderer.getScissor(new Vector4());
    const scissorTest = renderer.getScissorTest(), color = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear, toneMapping = renderer.toneMapping;
    try {
      renderer.autoClear = true; renderer.toneMapping = NoToneMapping;
      renderer.setScissorTest(false); renderer.setClearColor(0, 0);
      passes.forEach(pass => pass.initialize(renderer, true, HalfFloatType));
      for (const [width, height] of [[32, 32], [45, 35]]) {
        for (const target of [input, output, readback]) target.setSize(width, height);
        sourceMaterial.uniforms.size.value.set(width, height);
        copyMaterial.uniforms.size.value.set(width, height);
        source.render(renderer, null, input);
        const read = (texture: typeof input.texture) => {
          copyMaterial.uniforms.map.value = texture;
          copy.render(renderer, null, readback);
          const values = new Float32Array(width * height * 4);
          renderer.readRenderTargetPixels(readback, 0, 0, width, height, values);
          return values;
        };
        const original = read(input.texture);
        for (const [i, effect] of [stock, fixed].entries()) {
          const pass = passes[i]; pass.setSize(width, height);
          pass.render(renderer, input, output, 0, false);
          cases.push(measure(i ? 'perceptual-high' : 'stock-high', width, height,
            original, read(effect.edgesTexture), read(effect.weightsTexture), read(output.texture)));
        }
      }
    } finally {
      renderer.setRenderTarget(target, face, mip); renderer.setViewport(viewport); renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest); renderer.setClearColor(color, alpha);
      renderer.autoClear = autoClear; renderer.toneMapping = toneMapping;
    }
    return { passed: cases.every(c => c.passed), cases };
  } finally {
    passes.forEach(pass => pass.dispose()); source.dispose(); copy.dispose();
    input.dispose(); output.dispose(); readback.dispose();
  }
}

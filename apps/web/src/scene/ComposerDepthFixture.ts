import { BlendFunction, Effect, EffectAttribute, EffectComposer, EffectPass, RenderPass, type CopyPass } from 'postprocessing';
import {
  Color, FloatType, Mesh, MeshBasicMaterial, NearestFilter, PerspectiveCamera, PlaneGeometry,
  Scene, Vector2, Vector4, type Texture, type WebGLRenderer, type WebGLRenderTarget,
} from 'three';
import { isolateComposerDepthStorage } from './libraryComposerDepth';
import type { CloudConformanceResources } from './clouds/CloudConformanceResources';
import type { CloudConformanceResult } from './clouds/CloudConformanceFixture';

// Present in postprocessing 6.39.4's runtime, but absent from its declarations.
interface ComposerInternals {
  stableDepthTexture: Texture | null;
  depthRenderTarget: WebGLRenderTarget | null;
  copyPass: CopyPass;
}

/** Real GPU regression for cloned depth Sources aliasing a sampled attachment.
 * Entire setup/render/resize/readback/cleanup is synchronous on the live renderer.
 */
export function runComposerDepthConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance = 1e-3,
): CloudConformanceResult[] {
  const cases: CloudConformanceResult[] = [];
  const record = (name: string, measured: readonly number[], expected: readonly number[], limit = tolerance) => {
    const finite = measured.length === expected.length && measured.every(Number.isFinite);
    const maxError = finite ? Math.max(...measured.map((value, i) => Math.abs(value - expected[i]!))) : Infinity;
    cases.push({ name: `composer-depth-${name}`, measured, expected, maxError, passed: finite && maxError <= limit });
  };
  const gl = renderer.getContext();
  const recordErrors = (name: string) => {
    const errors: number[] = [];
    // Bounded even on context loss; never silently discard an existing error.
    for (let i = 0; i < 16; i++) {
      const error = gl.getError();
      if (error === gl.NO_ERROR) break;
      errors.push(error);
    }
    record(`${name}-gl-errors`, [errors.length, ...errors], new Array(errors.length + 1).fill(0), 0);
  };
  const handle = (texture: Texture) =>
    (renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture;

  const size = renderer.getSize(new Vector2());
  const pixelRatio = renderer.getPixelRatio();
  const canvasWidth = renderer.domElement.width;
  const canvasHeight = renderer.domElement.height;
  const xrEnabled = renderer.xr.enabled;
  const shadowEnabled = renderer.shadowMap.enabled;
  const target = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const mip = renderer.getActiveMipmapLevel();
  const viewport = renderer.getViewport(new Vector4());
  const scissor = renderer.getScissor(new Vector4());
  const scissorTest = renderer.getScissorTest();
  const clearColor = renderer.getClearColor(new Color());
  const clearAlpha = renderer.getClearAlpha();
  const autoClear = renderer.autoClear;
  const toneMapping = renderer.toneMapping;
  const currentViewport = renderer.getCurrentViewport(new Vector4());
  const gpuViewport = new Vector4().fromArray(gl.getParameter(gl.VIEWPORT) as Int32Array);
  const gpuScissor = new Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX) as Int32Array);
  const gpuScissorTest = gl.isEnabled(gl.SCISSOR_TEST);

  const camera = new PerspectiveCamera(60, 9 / 7, 1, 15);
  const geometry = new PlaneGeometry(64, 64);
  const material = new MeshBasicMaterial({ color: 0xff0000, toneMapped: false });
  const plane = new Mesh(geometry, material);
  const scene = new Scene();
  scene.add(plane);
  const renderPass = new RenderPass(scene, camera);
  const depthPass = new EffectPass(camera, new Effect('ComposerDepthProbe', `
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      // Sample the actual stable depth uniform, without postprocessing's depth
      // decoding compatibility layer: this fixture tests storage, not decoding.
      float storedDepth = texture2D(depthBuffer, uv).r;
      outputColor = vec4(0.125, storedDepth, 0.375, 1.0);
    }`, { attributes: EffectAttribute.DEPTH, blendFunction: BlendFunction.SRC }));
  const finalPass = new EffectPass(camera, new Effect('ComposerFinalProbe', `
    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
      outputColor = vec4(inputColor.r + 0.125, inputColor.g * 0.5 + 0.125, inputColor.b + 0.25, 1.0);
    }`, { blendFunction: BlendFunction.SRC }));
  depthPass.encodeOutput = finalPass.encodeOutput = false;
  let composer: EffectComposer | undefined;
  try {
    resources.draw(() => {
      try {
        recordErrors('entry');
        renderer.xr.enabled = false;
        renderer.shadowMap.enabled = false;
        // Unlike draw(), composer.setSize changes the live canvas's logical and
        // physical size. Never update CSS, and restore sizes inside this turn.
        renderer.setDrawingBufferSize(9, 7, 1);
        composer = new EffectComposer(renderer, { frameBufferType: FloatType, depthBuffer: true, multisampling: 0 });
        composer.autoRenderToScreen = false;
        composer.addPass(renderPass);
        composer.addPass(depthPass);
        composer.addPass(finalPass);
        const internals = composer as unknown as ComposerInternals;
        const stable = internals.stableDepthTexture;
        const stableTarget = internals.depthRenderTarget;
        if (!stable || !stableTarget || !composer.inputBuffer.depthTexture || !composer.outputBuffer.depthTexture) {
          throw new Error('Composer depth fixture requires input, output and stable depth textures');
        }
        const textures = [composer.inputBuffer.depthTexture, composer.outputBuffer.depthTexture, stable];
        const targets = [composer.inputBuffer, composer.outputBuffer, stableTarget];
        for (const buffer of [composer.inputBuffer, composer.outputBuffer]) {
          buffer.texture.minFilter = buffer.texture.magFilter = NearestFilter;
        }
        record('unallocated-before-isolation', textures.map(texture => Number(handle(texture) === undefined)), [1, 1, 1], 0);
        isolateComposerDepthStorage(composer);
        const sources = textures.map(texture => texture.source);
        const images = textures.map(texture => texture.image);
        isolateComposerDepthStorage(composer);
        record('isolation-is-idempotent', textures.map((texture, i) =>
          Number(texture.source === sources[i] && texture.image === images[i])), [1, 1, 1], 0);

        const verifyStorage = (name: string, width: number, height: number) => {
          const current = [composer!.inputBuffer.depthTexture, composer!.outputBuffer.depthTexture, internals.stableDepthTexture];
          record(`${name}-preserves-borrowed-textures`, [
            ...current.map((texture, i) => Number(texture === textures[i])), Number(depthPass.getDepthTexture() === stable),
          ], [1, 1, 1, 1], 0);
          record(`${name}-independent-sources-and-images`, [
            new Set(textures.map(texture => texture.source)).size, new Set(textures.map(texture => texture.image)).size,
            ...textures.map((texture, i) => Number(texture.source === sources[i] && texture.image === images[i])),
          ], [3, 3, 1, 1, 1], 0);
          const handles = textures.map(handle);
          record(`${name}-distinct-gpu-handles`, [
            ...handles.map(value => Number(value !== undefined && gl.isTexture(value))),
            Number(handles[0] !== handles[1]), Number(handles[0] !== handles[2]), Number(handles[1] !== handles[2]),
          ], [1, 1, 1, 1, 1, 1], 0);
          record(`${name}-depth-image-sizes`, textures.flatMap(texture => [texture.image.width, texture.image.height]),
            [width, height, width, height, width, height], 0);
        };
        const readPixel = (buffer: WebGLRenderTarget, x: number, y: number): number[] => {
          const pixel = new Float32Array(4).fill(NaN);
          renderer.readRenderTargetPixels(buffer, x, y, 1, 1, pixel);
          return Array.from(pixel);
        };
        for (const [name, width, height, distance, logDepth] of [
          ['initial', 9, 7, 3, 0.5], ['resized', 13, 11, 7, 0.75],
        ] as const) {
          composer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          plane.position.z = -distance;
          // Allocate one attachment at a time. Resizing input must not mutate
          // the output/stable images before their own allocation updates them.
          renderer.initRenderTarget(targets[0]!);
          if (name === 'resized') {
            record('resize-input-does-not-resize-other-images', textures.flatMap(texture => [texture.image.width, texture.image.height]),
              [13, 11, 9, 7, 9, 7], 0);
          }
          renderer.initRenderTarget(targets[1]!);
          if (name === 'resized') {
            record('resize-output-does-not-resize-stable-image', [stable.image.width, stable.image.height], [9, 7], 0);
          }
          renderer.initRenderTarget(stableTarget);
          verifyStorage(`${name}-setup`, width, height);
          recordErrors(`${name}-setup`);
          record(`${name}-two-offscreen-swaps`, [
            Number(!composer.autoRenderToScreen && composer.passes.every(pass => !pass.renderToScreen)),
            Number(!renderPass.needsSwap && depthPass.needsSwap && finalPass.needsSwap),
          ], [1, 1], 0);
          composer.render(0);
          verifyStorage(`${name}-render`, width, height);
          // The flat plane is 3/7 m from a camera with far=15 m: its stored
          // logarithmic depths are exactly log2(4)/log2(16) and log2(8)/log2(16).
          // Also allow a focused run on an ordinary perspective-depth renderer.
          const depth = renderer.capabilities.logarithmicDepthBuffer ? logDepth : 15 / 14 * (1 - 1 / distance);
          const intermediate = readPixel(composer.outputBuffer, width >> 1, height >> 1);
          record(`${name}-first-effect-pixel`, intermediate, [0.125, depth, 0.375, 1]);
          record(`${name}-sampled-depth-in-range`, [Number(intermediate[1]! > 0 && intermediate[1]! < 1)], [1], 0);
          // RenderPass writes input; effect one swaps to output, effect two
          // swaps back to input. Red/raw scene, cleared/stale, and one-pass
          // output all fail these independent analytical channel expectations.
          const expected = [0.25, depth * 0.5 + 0.125, 0.625, 1];
          record(`${name}-final-pixel-after-two-swaps`, readPixel(composer.inputBuffer, width >> 1, height >> 1), expected);
          record(`${name}-final-corner-pixel`, readPixel(composer.inputBuffer, width - 1, height - 1), expected);
          recordErrors(`${name}-render-and-readback`);
        }
      } finally {
        try {
          renderer.setRenderTarget(null);
          // composer.dispose() also disposes Pass.fullscreenGeometry, shared by
          // the live game. Release only this composer's owned resources instead.
          if (composer) {
            composer.removeAllPasses();
            composer.inputBuffer.dispose();
            composer.outputBuffer.dispose();
            (composer as unknown as ComposerInternals).copyPass.dispose();
            composer.getTimer().dispose();
          }
          renderPass.dispose();
          depthPass.dispose();
          finalPass.dispose();
          geometry.dispose();
          material.dispose();
          scene.clear();
        } finally {
          renderer.xr.enabled = xrEnabled;
          renderer.shadowMap.enabled = shadowEnabled;
          renderer.setDrawingBufferSize(size.x, size.y, pixelRatio);
          // Preserve even a canvas whose physical dimensions were set directly.
          if (renderer.domElement.width !== canvasWidth) renderer.domElement.width = canvasWidth;
          if (renderer.domElement.height !== canvasHeight) renderer.domElement.height = canvasHeight;
        }
      }
    });
  } finally {
    // draw() restores logical viewport/scissor, target/face/mip, clear color,
    // autoClear and toneMapping. A bound target can have a different physical
    // viewport/scissor; restore those too, without changing the logical values.
    if (!renderer.getCurrentViewport(new Vector4()).equals(currentViewport)) renderer.setRenderTarget(target, face, mip);
    renderer.state.viewport(gpuViewport);
    renderer.state.scissor(gpuScissor);
    renderer.state.setScissorTest(gpuScissorTest);
  }
  record('restored-canvas-and-target', [
    renderer.getPixelRatio(), ...renderer.getSize(new Vector2()).toArray(), renderer.domElement.width, renderer.domElement.height,
    Number(renderer.getRenderTarget() === target), renderer.getActiveCubeFace(), renderer.getActiveMipmapLevel(),
  ], [pixelRatio, size.x, size.y, canvasWidth, canvasHeight, 1, face, mip], 0);
  record('restored-renderer-state', [
    Number(renderer.getViewport(new Vector4()).equals(viewport)), Number(renderer.getScissor(new Vector4()).equals(scissor)),
    Number(renderer.getScissorTest() === scissorTest), Number(renderer.getCurrentViewport(new Vector4()).equals(currentViewport)),
    Number(new Vector4().fromArray(gl.getParameter(gl.VIEWPORT) as Int32Array).equals(gpuViewport)),
    Number(new Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX) as Int32Array).equals(gpuScissor)),
    Number(gl.isEnabled(gl.SCISSOR_TEST) === gpuScissorTest), Number(renderer.getClearColor(new Color()).equals(clearColor)),
    Number(renderer.getClearAlpha() === clearAlpha), Number(renderer.autoClear === autoClear), Number(renderer.toneMapping === toneMapping),
    Number(renderer.xr.enabled === xrEnabled), Number(renderer.shadowMap.enabled === shadowEnabled),
  ], new Array(13).fill(1), 0);
  recordErrors('cleanup');
  return cases;
}

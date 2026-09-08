import { afterEach, describe, expect, it } from 'vitest';
import { AerialPerspectiveEffect } from '@takram/three-atmosphere';
import { CloudsEffect } from '@takram/three-clouds';
import { OrthographicCamera, PerspectiveCamera, ShaderChunk, Vector3, Vector4 } from 'three';
import {
  AERIAL_DEPTH_BLOCK, StableAerialPerspectiveEffect, stableAerialDepth, stabilizeCloudDepth,
} from './libraryDepth';
import { CAMERA_FAR, CAMERA_NEAR } from './sky/skyConfig';

const disposables: { dispose(): void }[] = [];
afterEach(() => disposables.splice(0).forEach(effect => effect.dispose()));
function own<T extends { dispose(): void }>(effect: T): T {
  disposables.push(effect);
  return effect;
}
const camera = () => new PerspectiveCamera(45, 1280 / 720, CAMERA_NEAR, CAMERA_FAR);
const compact = (source: string) => source.replace(/\s+/g, '');
const CLOUD_DEPTH_BLOCK = '    depth = reverseLogDepth(depth, cameraNear, cameraFar);\n    viewZ = getViewZ(depth);';
const DIRECT_VIEW_Z = '-(exp2(depth * log2(cameraFar + 1.0)) - 1.0)';

// Verify a single surgical substitution against the actual installed class,
// including every byte outside the patch. No mocked shader/source fixture.
function changedBlock(before: string, after: string, oldBlock: string): string {
  expect(before.split(oldBlock)).toHaveLength(2);
  const [prefix, suffix] = before.split(oldBlock);
  expect(after.startsWith(prefix)).toBe(true);
  expect(after.endsWith(suffix)).toBe(true);
  expect(after).not.toContain(oldBlock);
  return after.slice(prefix.length, after.length - suffix.length);
}

describe('pinned Takram depth shader compatibility', () => {
  it('patches the real aerial class exactly once and preserves all other shading', () => {
    const original = own(new AerialPerspectiveEffect(camera())).getFragmentShader();
    const patched = own(new StableAerialPerspectiveEffect(camera())).getFragmentShader();
    expect(patched).toBe(stableAerialDepth(original));
    const block = changedBlock(original, patched, AERIAL_DEPTH_BLOCK);
    expect(compact(block)).toContain(compact(`float viewZ = ${DIRECT_VIEW_Z};`));
    expect(compact(block)).toContain('viewPosition=viewRay*(viewZ/viewRay.z);');
    expect(compact(block)).toContain('vec4(uv*2.0-1.0,1.0,1.0)');
    expect(block).not.toContain('reverseLogDepth');
    expect(() => stableAerialDepth(patched)).toThrow('Pinned Takram depth shader changed');
  });

  it('fails closed if the upstream aerial block disappears or occurs twice', () => {
    const original = own(new AerialPerspectiveEffect(camera())).getFragmentShader();
    for (const source of [original.replace(AERIAL_DEPTH_BLOCK, ''), original + AERIAL_DEPTH_BLOCK]) {
      expect(() => stableAerialDepth(source)).toThrow('Pinned Takram depth shader changed');
    }
  });

  it('patches the real cloud material once and invalidates its compiled program', () => {
    const clouds = own(new CloudsEffect(camera()));
    const material = clouds.cloudsPass.currentMaterial;
    const original = material.fragmentShader;
    const version = material.version;
    stabilizeCloudDepth(clouds);
    const block = changedBlock(original, material.fragmentShader, CLOUD_DEPTH_BLOCK);
    expect(compact(block)).toContain(compact(`viewZ = ${DIRECT_VIEW_Z};`));
    expect(block).not.toContain('reverseLogDepth');
    expect(material.version).toBe(version + 1);
    const patched = material.fragmentShader;
    expect(() => stabilizeCloudDepth(clouds)).toThrow('Pinned Takram depth shader changed');
    expect(material.fragmentShader).toBe(patched);
    expect(material.version).toBe(version + 1);
  });

  it.each(['missing', 'duplicate'])('rejects a %s cloud block without mutating the material', mode => {
    const clouds = own(new CloudsEffect(camera()));
    const material = clouds.cloudsPass.currentMaterial;
    material.fragmentShader = mode === 'missing'
      ? material.fragmentShader.replace(CLOUD_DEPTH_BLOCK, '')
      : material.fragmentShader + CLOUD_DEPTH_BLOCK;
    const before = material.fragmentShader;
    const version = material.version;
    expect(() => stabilizeCloudDepth(clouds)).toThrow('Pinned Takram depth shader changed');
    expect(material.fragmentShader).toBe(before);
    expect(material.version).toBe(version);
  });
});

// CPU Float32 oracle, not GPU execution. Round each arithmetic operation;
// also model a contracted multiply/subtract because shader compilers may fuse it.
const f = Math.fround;
function depthRoundTrip(distance: number) {
  const near = f(CAMERA_NEAR), far = f(CAMERA_FAR);
  const logDepthBufFC = f(2 / Math.log2(CAMERA_FAR + 1));
  const depth = f(f(f(Math.log2(f(distance + 1))) * logDepthBufFC) * 0.5);
  const direct = f(f(2 ** f(depth * f(Math.log2(f(far + 1))))) - 1);
  const a = f(far / f(far - near));
  const b = f(f(far * near) / f(near - far));
  const conventional = f(a + f(b / direct));
  const numerator = f(near * far);
  const separated = -f(numerator / f(f(f(far - near) * conventional) - far));
  const contracted = -f(numerator / f(f(far - near) * conventional - far));
  return { direct, conventional, separated, contracted };
}

describe('Float32 depth reconstruction regression', () => {
  it('connects the numeric model to stock Three encoding and installed Takram decoding', () => {
    expect([CAMERA_NEAR, CAMERA_FAR]).toEqual([0.5, 1e8]);
    expect(compact(ShaderChunk.logdepthbuf_vertex)).toContain('vFragDepth=1.0+gl_Position.w;');
    expect(compact(ShaderChunk.logdepthbuf_fragment)).toContain('log2(vFragDepth)*logDepthBufFC*0.5');
    expect(compact(ShaderChunk.packing)).toContain('(near*far)/((far-near)*depth-far)');
    const original = compact(own(new AerialPerspectiveEffect(camera())).getFragmentShader());
    for (const expression of [
      'float d = pow(2.0, depth * log2(far + 1.0)) - 1.0;',
      'float a = far / (far - near);', 'float b = far * near / (near - far);', 'return a + b / d;',
    ]) expect(original).toContain(compact(expression));
  });

  it.each([
    [10, 0.00001, 0], [3000, 0.01, 0.2], [100000, 0.25, 100], [400000, 0.5, 500],
  ])('preserves %sm with direct error < %sm', (distance, directTolerance, legacyErrorFloor) => {
    const result = depthRoundTrip(distance);
    expect(Math.abs(result.direct - distance)).toBeLessThan(directTolerance);
    for (const legacy of [result.separated, result.contracted]) {
      expect(Math.abs(legacy - distance)).toBeGreaterThanOrEqual(legacyErrorFloor);
    }
  });

  it('preserves the 20 km interval that conventional Float32 depth collapses to one value', () => {
    const distances = [410000, 420000, 430000];
    const results = distances.map(depthRoundTrip);
    expect(new Set(results.map(result => result.conventional)).size).toBe(1);
    for (const path of ['separated', 'contracted'] as const) {
      expect(new Set(results.map(result => result[path])).size).toBe(1);
      expect(Math.max(...results.map((result, i) => Math.abs(result[path] - distances[i])))).toBeGreaterThan(10000);
    }
    results.forEach((result, i) => expect(Math.abs(result.direct - distances[i])).toBeLessThan(0.25));
  });

  it('reconstructs off-axis view positions using eye-space Z, not radial distance', () => {
    const projection = camera();
    // An asymmetric frustum catches assumptions that only work at screen center.
    projection.setViewOffset(1280, 720, 80, 30, 1000, 600);
    for (const [x, y] of [[0, 0], [-0.9, 0.8], [0.85, -0.75]]) {
      const ray = new Vector4(x, y, 1, 1).applyMatrix4(projection.projectionMatrixInverse);
      const viewZ = -depthRoundTrip(400000).direct;
      const position = new Vector3(ray.x, ray.y, ray.z).multiplyScalar(viewZ / ray.z);
      const projected = new Vector4(...position.toArray(), 1).applyMatrix4(projection.projectionMatrix);
      expect(projected.x / projected.w).toBeCloseTo(x, 12);
      expect(projected.y / projected.w).toBeCloseTo(y, 12);
      expect(Math.abs(position.z + 400000)).toBeLessThan(0.5);
    }
  });
});

describe('conventional and orthographic depth fallbacks', () => {
  it('keeps raw conventional depth for aerial orthographic and non-log branches', () => {
    const block = stableAerialDepth(AERIAL_DEPTH_BLOCK);
    const fallback = 'viewPosition = screenToView(uv, depth, getViewZ(depth), projectionMatrix, inverseProjectionMatrix);';
    expect(block).toContain('#if defined(USE_LOGDEPTHBUF) || defined(USE_LOGARITHMIC_DEPTH_BUFFER)');
    expect(block).toContain('if (projectionMatrix[2][3] != 0.0)');
    expect(block).toMatch(new RegExp(`} else \\{\\s*${fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(block).toContain(`#else\n  ${fallback}`);
    expect(compact(ShaderChunk.logdepthbuf_fragment)).toContain('vIsPerspective==0.0?gl_FragCoord.z:');

    const ortho = new OrthographicCamera(-100, 100, 60, -60, CAMERA_NEAR, CAMERA_FAR);
    expect(ortho.projectionMatrix.elements[11]).toBe(0);
    expect(camera().projectionMatrix.elements[11]).not.toBe(0);
    for (const point of [new Vector3(30, -20, -10), new Vector3(-70, 40, -400000)]) {
      const ndc = point.clone().project(ortho);
      const depth = f((ndc.z + 1) * 0.5);
      const viewZ = f(f(depth * f(CAMERA_NEAR - CAMERA_FAR)) - CAMERA_NEAR);
      const clipW = ortho.projectionMatrix.elements[11] * viewZ + ortho.projectionMatrix.elements[15];
      const restored = new Vector4(ndc.x, ndc.y, depth * 2 - 1, 1)
        .multiplyScalar(clipW).applyMatrix4(ortho.projectionMatrixInverse);
      expect(new Vector3(restored.x, restored.y, restored.z).distanceTo(point)).toBeLessThan(0.02);
      // Orthographic depth is linear even when the renderer enables log depth.
      const incorrectlyDecoded = 2 ** (depth * Math.log2(CAMERA_FAR + 1)) - 1;
      expect(Math.abs(incorrectlyDecoded + point.z)).toBeGreaterThan(-point.z * 0.9);
    }
  });

  it('requires the cloud log decoder to guard perspective cameras and retain a conventional fallback', () => {
    const clouds = own(new CloudsEffect(new OrthographicCamera(-10, 10, 10, -10, CAMERA_NEAR, CAMERA_FAR)));
    const original = clouds.cloudsPass.currentMaterial.fragmentShader;
    stabilizeCloudDepth(clouds);
    const block = changedBlock(original, clouds.cloudsPass.currentMaterial.fragmentShader, CLOUD_DEPTH_BLOCK);
    const condition = block.match(/#if ([^\n]+)/)?.[1];
    expect(condition).toBeDefined();
    for (const logDefine of [undefined, 'USE_LOGDEPTHBUF', 'USE_LOGARITHMIC_DEPTH_BUFFER']) {
      for (const perspective of [false, true]) {
        const defines = new Set([logDefine, ...(perspective ? ['PERSPECTIVE_CAMERA'] : [])]);
        const predicate = condition!.replace(/defined\((\w+)\)/g, (_, name: string) => String(defines.has(name)));
        // Evaluate only whitelisted boolean syntax, with GLSL's operator precedence.
        // This also catches a missing pair of parentheses around the two log flags.
        expect(predicate).toMatch(/^(?:true|false|\s|[()!]|&&|\|\|)+$/);
        const takesLogBranch = Boolean(Function(`return (${predicate});`)());
        expect(takesLogBranch, `${logDefine ?? 'no log'}, perspective=${perspective}`)
          .toBe(logDefine != null && perspective);
      }
    }
    expect(block).toMatch(/#else\s+viewZ = getViewZ\(depth\);/);
  });
});

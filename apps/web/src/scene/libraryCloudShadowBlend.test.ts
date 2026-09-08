import { afterEach, describe, expect, it } from 'vitest';
import { AerialPerspectiveEffect } from '@takram/three-atmosphere';
import { CloudsEffect } from '@takram/three-clouds';
import { PerspectiveCamera, Ray, Sphere, Vector2, Vector3 } from 'three';
import { blendAerialCloudShadows } from './libraryCloudShadowBlend';
import { configureCloudShadowRange } from './libraryCloudShadowRange';
import { stableAerialShadowStorage } from './libraryCloudShadowStorage';
import { stableAerialDepth } from './libraryDepth';
import { CAMERA_FAR, CAMERA_NEAR, EARTH_RADIUS_M } from './sky/skyConfig';
import { directionToECEF } from './libraryFrame';
import { SUN_DIR } from './sun';

const owned: { dispose(): void }[] = [];
afterEach(() => { for (const resource of owned.splice(0)) resource.dispose(); });

function source() {
  const aerial = new AerialPerspectiveEffect(new PerspectiveCamera());
  owned.push(aerial);
  return aerial.getFragmentShader();
}

function setup(altitude = 20000, preset: 'low' | 'medium' = 'medium', pitch = -45) {
  // Confirmed GPU location and heading, with a camera-relative ECEF orientation.
  const lat = 40.5 * Math.PI / 180, lon = -75 * Math.PI / 180;
  const up = new Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  const east = new Vector3(-Math.sin(lon), Math.cos(lon), 0);
  const camera = new PerspectiveCamera(45, 1.3, CAMERA_NEAR, CAMERA_FAR);
  camera.up.copy(up);
  camera.lookAt(east.multiplyScalar(Math.cos(pitch * Math.PI / 180)).addScaledVector(up, Math.sin(pitch * Math.PI / 180)));
  camera.updateMatrixWorld(true);
  const clouds = new CloudsEffect(camera);
  owned.push(clouds);
  clouds.qualityPreset = preset;
  clouds.cloudLayers.reset().set([
    { altitude: 1000, height: 2000, densityScale: 0.12, shadow: true },
    { altitude: 7500, height: 500, densityScale: 0.003 },
  ]);
  configureCloudShadowRange(clouds, camera, { cameraAltitudeM: altitude });
  clouds.shadowMaps.update(camera, directionToECEF(SUN_DIR), 1000);
  return { camera, clouds, earth: new Sphere(up.multiplyScalar(-EARTH_RADIUS_M - altitude), EARTH_RADIUS_M) };
}
type Scene = ReturnType<typeof setup>;
type UV = { x: number; y: number };
type Read = (uv: UV, index: number) => number;

/** Execute the emitted GLSL's scalar control flow, not a second blend model.
 * Strip type declarations and bind GLSL builtins/texture reads. The one matrix
 * expression is evaluated by real Three matrices. This checks behavior and
 * coverage on CPU; it is not a driver compilation or rendered-image test.
 */
function execute(shader: string, scene: Scene, read: Read, overrides: Record<string, unknown> = {}) {
  let code = shader.slice(shader.indexOf('// CLOUD_SURFACE_SHADOW_BLEND'), shader.indexOf('float getShadowRadius('));
  expect(code).toContain('-(viewMatrix * vec4(worldPosition, 1.0)).z');
  code = code.replace('-(viewMatrix * vec4(worldPosition, 1.0)).z', 'evaluateViewDepth(worldPosition)')
    .replace(/\b(float|bool|int|vec2|vec3)\s+(\w+)\s*\(([^)]*)\)\s*\{/g,
      (_, _type, name, args: string) => `function ${name}(${args.replace(/\b(const|float|bool|int|vec2|vec3)\b/g, '')}) {`)
    .replace(/\b(?:const\s+)?(?:float|bool|int|vec2|vec3)\s+(?=\w)/g, 'let ');
  const maps = scene.clouds.shadowMaps;
  const bindings = {
    SHADOW_SAMPLE_COUNT: 8, SHADOW_CASCADE_COUNT: maps.cascadeCount,
    cameraNear: scene.camera.near, shadowFar: maps.far, shadowIntervals: maps.cascades.map(c => c.interval),
    min: Math.min, max: Math.max, exp: Math.exp, log: Math.log,
    mix: (a: number, b: number, t: number) => a * (1 - t) + b * t,
    smoothstep: (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); },
    vec2: (x: UV | number, y: number) => typeof x === 'number' ? { x, y } : x,
    textureSize: () => ({ xy: maps.mapSize }), shadowBuffer: null,
    getDistanceToShadowTop: () => 3000,
    getShadowUv: (point: Vector3, index: number) => {
      const clip = point.clone().applyMatrix4(maps.cascades[index].matrix);
      return { x: clip.x * 0.5 + 0.5, y: clip.y * 0.5 + 0.5 };
    },
    evaluateViewDepth: (point: Vector3) => -point.clone().applyMatrix4(scene.camera.matrixWorldInverse).z,
    readShadowOpticalDepth: (uv: UV, _distance: number, index: number) => read(uv, index),
    vogelDisk: (i: number, n: number, angle: number) => {
      const r = Math.sqrt((i + 0.5) / n), theta = i * 2.399963229728653 + angle;
      return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
    },
    interleavedGradientNoise: () => 0, gl_FragCoord: { xy: new Vector2() }, PI2: Math.PI * 2,
    ...overrides,
  };
  return new Function(...Object.keys(bindings), `${code}\nreturn sampleShadowOpticalDepth;`)(...Object.values(bindings)) as
    (point: Vector3, positionECEF: Vector3, radius: number, jitter: number) => number;
}

function atDepth(scene: Scene, depth: number, x = 0, y = 0) {
  const view = new Vector3(x, y, 0).unproject(scene.camera).applyMatrix4(scene.camera.matrixWorldInverse);
  return view.multiplyScalar(depth / -view.z).applyMatrix4(scene.camera.matrixWorld);
}

function splitDepth(scene: Scene, index: number) {
  return scene.camera.near + scene.clouds.shadowMaps.cascades[index].interval.y * (scene.clouds.shadowMaps.far - scene.camera.near);
}

describe('continuous surface cloud-shadow cascade blend', () => {
  it('changes only receiver selection, preserving mainImage, radius, storage reads and cloud geometry', () => {
    const original = source(), patched = blendAerialCloudShadows(original);
    const begin = original.indexOf('float sampleShadowOpticalDepth('), end = original.indexOf('float getShadowRadius(');
    expect(patched.slice(0, begin)).toBe(original.slice(0, begin));
    expect(patched.slice(patched.indexOf('float getShadowRadius('))).toBe(original.slice(end));
    expect(blendAerialCloudShadows(stableAerialShadowStorage(original))).toBe(stableAerialShadowStorage(patched));
    expect(blendAerialCloudShadows(stableAerialDepth(original))).toBe(stableAerialDepth(patched));
    expect(() => blendAerialCloudShadows(patched)).toThrow('Pinned Takram');
    expect(() => blendAerialCloudShadows(original + original)).toThrow('Pinned Takram');
    expect(() => blendAerialCloudShadows(original.replace('int cascadeIndex = getFadedCascadeIndex(', 'int cascadeIndex = changed('))).toThrow('Pinned Takram');
    for (const width of [0, 1e-10, NaN, Infinity, 0.51]) expect(() => blendAerialCloudShadows(original, width)).toThrow(RangeError);
  });

  it('reproduces the narrow stock fade at the reported 20 km view and broadens it continuously', () => {
    const scene = setup(), maps = scene.clouds.shadowMaps;
    const boundary = splitDepth(scene, 0), normalized = maps.cascades[0].interval.y;
    expect(maps.far).toBeGreaterThan(860000);
    expect(maps.far).toBeLessThan(870000);
    expect(boundary).toBeGreaterThan(31000);
    expect(boundary).toBeLessThan(31100);
    const stockWidth = normalized ** 2 * 0.5 * (maps.far - scene.camera.near);
    expect(stockWidth).toBeGreaterThan(550);
    expect(stockWidth).toBeLessThan(565);
    const shader = blendAerialCloudShadows(source());
    const sample = execute(shader, scene, (_uv, i) => -Math.log(i === 0 ? 0.2 : 0.8));
    const values: number[] = [];
    for (let i = 0; i <= 100; ++i) {
      const p = atDepth(scene, boundary * (0.8 + i * 0.002));
      values.push(Math.exp(-sample(p, p, 0, 0.5)));
    }
    expect(values[0]).toBeCloseTo(0.2, 5);
    expect(values[50]).toBeCloseTo(0.5, 4); // Arithmetic transmittance, not exp(mean tau)=0.4.
    expect(values[100]).toBeCloseTo(0.8, 5);
    for (let i = 1; i < values.length; ++i) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
      expect(values[i] - values[i - 1]).toBeLessThan(0.01);
    }
    const a = atDepth(scene, boundary - 0.001), b = atDepth(scene, boundary + 0.001);
    expect(Math.exp(-sample(a, a, 0, 0))).toBeCloseTo(Math.exp(-sample(b, b, 0, 1)), 8);
  });

  it('averages PCF transmittance without multiplying attenuation or letting missing taps add white', () => {
    const scene = setup(), shader = blendAerialCloudShadows(source());
    const p = atDepth(scene, 20000);
    const sample = execute(shader, scene, uv => uv.x < 0.5 ? -Math.log(0.2) : -Math.log(0.8), {
      getShadowUv: () => ({ x: 0.5, y: 0.5 }), SHADOW_SAMPLE_COUNT: 2,
      vogelDisk: (i: number) => ({ x: i ? 1 : -1, y: 0 }),
    });
    expect(Math.exp(-sample(p, p, 2, 0))).toBeCloseTo(0.5, 12);
    const edge = execute(shader, scene, uv => {
      expect(uv.x).toBeGreaterThanOrEqual(0);
      return -Math.log(0.2);
    }, {
      getShadowUv: () => ({ x: 0.001, y: 0.5 }), SHADOW_SAMPLE_COUNT: 2,
      vogelDisk: (i: number) => ({ x: i ? 1 : -1, y: 0 }),
    });
    expect(Math.exp(-edge(p, p, 2, 0))).toBeCloseTo(0.2, 12);
    // If every PCF offset misses, the valid center is retained.
    expect(Math.exp(-edge(p, p, 1000, 0))).toBeCloseTo(0.2, 12);
  });

  it('renormalizes to the valid adjacent map and ramps its entering UV coverage smoothly', () => {
    const scene = setup(), shader = blendAerialCloudShadows(source());
    const point = atDepth(scene, splitDepth(scene, 0) * 0.9);
    for (const invalid of [0, 1]) {
      const sample = execute(shader, scene, (_uv, i) => {
        expect(i).not.toBe(invalid);
        return -Math.log(0.2);
      }, { getShadowUv: (_p: Vector3, i: number) => ({ x: i === invalid ? -0.1 : 0.5, y: 0.5 }) });
      expect(Math.exp(-sample(point, point, 0, 0))).toBeCloseTo(0.2, 12);
    }
    const outputs: number[] = [];
    for (let edge = -0.1; edge <= 2.01; edge += 0.01) {
      const sample = execute(shader, scene, (_uv, i) => -Math.log(i === 0 ? 0.2 : 0.8), {
        getShadowUv: (_p: Vector3, i: number) => ({ x: i === 0 ? 0.5 : edge / 256, y: 0.5 }),
      });
      outputs.push(Math.exp(-sample(point, point, 0, 0)));
    }
    for (let i = 1; i < outputs.length; ++i) expect(Math.abs(outputs[i] - outputs[i - 1])).toBeLessThan(0.005);
    expect(outputs[0]).toBeCloseTo(0.2, 8);
    expect(outputs.at(-1)).toBeCloseTo(0.5, 4);
  });

  it('narrows the blend safely when real CSM geometry cannot cover the requested full width', () => {
    const scene = setup();
    // A narrow-FOV counterexample to assuming all larger maps contain every
    // nearer point. The next CSM frustum begins ahead of this receiver.
    scene.camera.fov = 5;
    scene.camera.quaternion.identity();
    scene.camera.updateProjectionMatrix();
    scene.camera.updateMatrixWorld(true);
    scene.clouds.shadowMaps.update(scene.camera, new Vector3(1, 0, 0), 1000);
    const boundary = splitDepth(scene, 0), readIndices = new Set<number>();
    const sample = execute(blendAerialCloudShadows(source()), scene, (uv, i) => {
      expect(uv.x).toBeGreaterThanOrEqual(0); expect(uv.x).toBeLessThanOrEqual(1);
      readIndices.add(i);
      return -Math.log(i === 0 ? 0.2 : 0.8);
    });
    const early = atDepth(scene, boundary * 0.9);
    const clip = early.clone().applyMatrix4(scene.clouds.shadowMaps.cascades[1].matrix);
    expect(Math.abs(clip.x)).toBeGreaterThan(1);
    expect(Math.exp(-sample(early, early, 0, 0.5))).toBeCloseTo(0.2, 12);
    expect([...readIndices]).toEqual([0]);
    let previous = 0.2;
    for (let i = 0; i <= 2000; ++i) {
      const point = atDepth(scene, boundary * (0.8 + i * 0.0001));
      const value = Math.exp(-sample(point, point, 0, 0.5));
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
    expect(previous).toBeCloseTo(0.8, 10);
    // Actual orthographic UV varies linearly along this ray. Locate the map's
    // entry edge and verify both that edge and the nominal split are continuous,
    // rather than imposing an unsupported minimum physical overlap width.
    const endClip = atDepth(scene, boundary).applyMatrix4(scene.clouds.shadowMaps.cascades[1].matrix);
    const entryDepth = boundary * (0.9 + 0.1 * (Math.sign(clip.x) - clip.x) / (endClip.x - clip.x));
    for (const depth of [entryDepth, boundary]) {
      const a = atDepth(scene, depth - 0.0001), b = atDepth(scene, depth + 0.0001);
      expect(Math.exp(-sample(a, a, 0, 0))).toBeCloseTo(Math.exp(-sample(b, b, 0, 1)), 7);
    }
  });

  it.each([50, 3000, 20000, 120000, 400000])('keeps valid coverage across the installed CSM splits at %i m', altitude => {
    const shader = blendAerialCloudShadows(source());
    for (const preset of ['low', 'medium'] as const) for (const pitch of [-90, -45, -5]) {
      const scene = setup(altitude, preset, pitch), maps = scene.clouds.shadowMaps;
      let reads = 0, depth = 0;
      const sample = execute(shader, scene, (uv, index) => {
        ++reads;
        expect(uv.x).toBeGreaterThanOrEqual(0); expect(uv.x).toBeLessThanOrEqual(1);
        expect(uv.y).toBeGreaterThanOrEqual(0); expect(uv.y).toBeLessThanOrEqual(1);
        // Never extend an earlier map past its nominal interval's far depth.
        if (index < maps.cascadeCount - 1) expect(depth).toBeLessThanOrEqual(splitDepth(scene, index) + 1e-6);
        return -Math.log(0.3);
      });
      for (let boundary = 0; boundary < maps.cascadeCount - 1; ++boundary) {
        const end = splitDepth(scene, boundary);
        const start = boundary > 0 ? splitDepth(scene, boundary - 1) : scene.camera.near;
        for (const fraction of [0.79, 0.8, 0.85, 0.9, 0.95, 0.99, 1, 1.001]) {
          depth = start + (end - start) * fraction;
          for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
            const point = atDepth(scene, depth, x, y);
            const before = reads;
            expect(Math.exp(-sample(point, point, 3, 0.5))).toBeCloseTo(0.3, 9);
            expect(reads).toBeGreaterThan(before);
          }
        }
        const contrasting = execute(shader, scene, (_uv, i) => -Math.log(0.2 + i * 0.3));
        for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
          const a = atDepth(scene, end - 0.001, x, y), b = atDepth(scene, end + 0.001, x, y);
          expect(Math.exp(-contrasting(a, a, 0, 0))).toBeCloseTo(Math.exp(-contrasting(b, b, 0, 1)), 8);
        }
      }
      // Real visible surface receivers, including oblique near-horizon rays.
      for (let y = -5; y <= 5; ++y) for (let x = -5; x <= 5; ++x) {
        const direction = new Vector3(x / 5, y / 5, 0).unproject(scene.camera).normalize();
        const point = new Ray(new Vector3(), direction).intersectSphere(scene.earth, new Vector3());
        if (!point) continue;
        depth = -point.clone().applyMatrix4(scene.camera.matrixWorldInverse).z;
        expect(Math.exp(-sample(point, point, 3, 0.5))).toBeCloseTo(0.3, 9);
      }
    }
  });

  it('retains UV-only last-map coverage and finite opaque output, including a single cascade', () => {
    const scene = setup(), shader = blendAerialCloudShadows(source());
    scene.clouds.shadow.cascadeCount = 1;
    scene.clouds.shadowMaps.update(scene.camera, scene.camera.getWorldDirection(new Vector3()).negate(), 1000);
    const beyond = atDepth(scene, scene.clouds.shadowMaps.far * 1.1);
    const sample = execute(shader, scene, () => 1000);
    expect(sample(beyond, beyond, 0, 0.5)).toBeGreaterThan(60);
    expect(Number.isFinite(sample(beyond, beyond, 0, 0.5))).toBe(true);
    const outside = execute(shader, scene, () => { throw new Error('Invalid UV must not read'); }, {
      getShadowUv: () => ({ x: 1.1, y: 0.5 }),
    });
    expect(outside(beyond, beyond, 0, 0.5)).toBeCloseTo(0, 12);
    const above = execute(shader, scene, () => { throw new Error('Above shadow shell must not read'); }, {
      getDistanceToShadowTop: () => -1,
    });
    expect(above(beyond, beyond, 0, 0.5)).toBe(0);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { CloudsEffect } from '@takram/three-clouds';
import { DataUtils, HalfFloatType, PerspectiveCamera, Ray, RGBAFormat, Sphere, Vector3 } from 'three';
import { configureCloudShadowRange } from './libraryCloudShadowRange';
import { CAMERA_FAR, CAMERA_NEAR, EARTH_RADIUS_M, SKY_CONFIG } from './sky/skyConfig';

const effects: CloudsEffect[] = [];
afterEach(() => { for (const effect of effects.splice(0)) effect.dispose(); });

function setup(altitudeM: number, preset: 'low' | 'medium' = 'medium', tiltDeg = 0, scale = 1, aspect = 16 / 9) {
  const camera = new PerspectiveCamera(45, aspect,
    CAMERA_NEAR * SKY_CONFIG.renderScaleMPerUnit / scale,
    CAMERA_FAR * SKY_CONFIG.renderScaleMPerUnit / scale);
  // Camera-relative world: the surface directly below the camera is the origin.
  camera.position.set(0, altitudeM / scale, 0);
  camera.up.set(0, 0, 1);
  camera.lookAt(camera.position.clone().add(new Vector3(0,
    -Math.cos(tiltDeg * Math.PI / 180), Math.sin(tiltDeg * Math.PI / 180))));
  camera.updateMatrixWorld(true);
  const clouds = new CloudsEffect(camera);
  effects.push(clouds);
  clouds.qualityPreset = preset;
  // The actual prototype's global weather geometry; no shader adapter required.
  clouds.cloudLayers.reset().set([
    { altitude: 1000, height: 2000, densityScale: 0.12, shadow: true },
    { altitude: 7500, height: 500, densityScale: 0.003, shadow: false },
  ]);
  const center = new Vector3(0, -EARTH_RADIUS_M / scale, 0);
  return { clouds, camera, center, scale, altitudeM };
}
type Scene = ReturnType<typeof setup>;

function update(scene: Scene, sun = new Vector3(0, 1, 0)) {
  const range = configureCloudShadowRange(scene.clouds, scene.camera, {
    cameraAltitudeM: scene.altitudeM, renderScaleMPerUnit: scene.scale,
  });
  // Exercise the installed CascadedShadowMaps, including its fade enlargement
  // and texel snapping. The light offset only translates along the ray axis.
  scene.clouds.shadowMaps.update(scene.camera, sun, 1000 / scene.scale);
  return range;
}

function texelM(scene: Scene, index: number) {
  const maps = scene.clouds.shadowMaps;
  const matrix = maps.cascades[index].inverseMatrix;
  return new Vector3(0, 0, 0).applyMatrix4(matrix)
    .distanceTo(new Vector3(2 / maps.mapSize.x, 0, 0).applyMatrix4(matrix)) * scene.scale;
}

function expectCovered(scene: Scene, receiver: Vector3) {
  const maps = scene.clouds.shadowMaps;
  const depth = -receiver.clone().applyMatrix4(scene.camera.matrixWorldInverse).z;
  expect(depth).toBeGreaterThan(scene.camera.near);
  expect(depth).toBeLessThan(maps.far);
  // Select from the package-produced intervals, as the receiving shaders do.
  const normalized = (depth - scene.camera.near) / (maps.far - scene.camera.near);
  const index = maps.cascades.findIndex(c => normalized >= c.interval.x && normalized < c.interval.y);
  expect(index).toBeGreaterThanOrEqual(0);
  const clip = receiver.clone().applyMatrix4(maps.cascades[index].matrix);
  // Takram samples XY; these maps encode cloud-ray depth, not a depth test in Z.
  expect(Math.abs(clip.x)).toBeLessThan(1);
  expect(Math.abs(clip.y)).toBeLessThan(1);
  return index;
}

// Independent geometry oracle: actual Three rays/spheres, including the far
// cloud-shell intersection when Earth does not occlude it. No range formula.
function visibleReceivers(scene: Scene) {
  const { camera, center, scale } = scene;
  const earth = new Sphere(center, EARTH_RADIUS_M / scale);
  const points: Vector3[] = [];
  for (let y = -4; y <= 4; ++y) for (let x = -4; x <= 4; ++x) {
    const direction = new Vector3(x / 4, y / 4, 0).unproject(camera).sub(camera.position).normalize();
    const ray = new Ray(camera.position, direction);
    const ground = ray.intersectSphere(earth, new Vector3());
    const groundDistance = ground ? ground.distanceTo(camera.position) : Infinity;
    if (ground) points.push(ground);
    for (const height of [1000, 3000, 8000]) {
      const shell = new Sphere(center, (EARTH_RADIUS_M + height) / scale);
      const entry = ray.intersectSphere(shell, new Vector3());
      if (!entry) continue;
      if (entry.distanceTo(camera.position) < groundDistance) points.push(entry);
      const nextRay = new Ray(entry.clone().addScaledVector(direction, 0.01 / scale), direction);
      const exit = nextRay.intersectSphere(shell, new Vector3());
      if (exit && exit.distanceTo(camera.position) < groundDistance) points.push(exit);
    }
  }
  // A camera exactly on a shell produces a zero-distance intersection, before
  // the raster camera's near plane; it is not a receiver in the rendered view.
  return points.filter(point => -point.clone().applyMatrix4(camera.matrixWorldInverse).z > camera.near);
}

describe('bounded cloud shadows using the installed Takram cascade geometry', () => {
  it.each(['low', 'medium'] as const)('improves %s nadir texel footprints at all four operating altitudes', preset => {
    for (const [altitude, firstTexelLimitM, horizonTexelLimitM] of [
      [50, 60, 3000], [3000, 70, 4500], [120000, 1300, 13000], [400000, 4300, 22000],
    ]) {
      const scene = setup(altitude, preset);
      scene.clouds.shadowMaps.update(scene.camera, new Vector3(0, 1, 0), 1000);
      const oldFirst = texelM(scene, 0);
      const oldLast = texelM(scene, scene.clouds.shadow.cascadeCount - 1);
      update(scene);
      expect(expectCovered(scene, new Vector3())).toBe(0);
      expect(texelM(scene, 0)).toBeLessThan(firstTexelLimitM);
      expect(texelM(scene, 0)).toBeLessThan(oldFirst / 20);
      const last = texelM(scene, scene.clouds.shadow.cascadeCount - 1);
      expect(last).toBeLessThan(horizonTexelLimitM);
      expect(last).toBeLessThan(oldLast / 30);
    }
  });

  it.each([50, 3000, 120000, 400000])('covers actual ground/cloud receivers at %i m, including oblique views and the limb', altitude => {
    const horizonTilt = Math.asin(EARTH_RADIUS_M / (EARTH_RADIUS_M + altitude)) * 180 / Math.PI;
    for (const preset of ['low', 'medium'] as const) {
      for (const tilt of [0, 60, horizonTilt - 0.1, horizonTilt + 0.1, 100]) {
        for (const sun of [new Vector3(0, 1, 0), new Vector3(0.8, 0.02, 0.6).normalize()]) {
          const scene = setup(altitude, preset, tilt, 1, 21 / 9);
          update(scene, sun);
          const receivers = visibleReceivers(scene);
          // At orbit a view pitched past the limb can legitimately see only space.
          if (tilt <= horizonTilt) expect(receivers.length).toBeGreaterThan(0);
          for (const receiver of receivers) expectCovered(scene, receiver);
        }
      }
    }
  });

  it('includes the far cloud shell beyond the ground horizon, not just the near cloud entry', () => {
    const scene = setup(400000, 'low');
    // A ray tangent 10 m above sea level avoids the opaque ground and traverses
    // both sides of the cloud shell. Construct it using the Three sphere oracle.
    const tilt = Math.asin((EARTH_RADIUS_M + 10) / (EARTH_RADIUS_M + scene.altitudeM));
    scene.camera.lookAt(scene.camera.position.clone().add(new Vector3(0, -Math.cos(tilt), Math.sin(tilt))));
    scene.camera.updateMatrixWorld(true);
    const ray = new Ray(scene.camera.position, scene.camera.getWorldDirection(new Vector3()));
    const shell = new Sphere(scene.center, EARTH_RADIUS_M + 8000);
    const entry = ray.intersectSphere(shell, new Vector3())!;
    const exit = new Ray(entry.clone().addScaledVector(ray.direction, 0.1), ray.direction).intersectSphere(shell, new Vector3())!;
    const range = update(scene);
    expect(exit.distanceTo(scene.camera.position)).toBeGreaterThan(range.groundHorizonM + 300000);
    expect(exit.distanceTo(scene.camera.position)).toBeLessThan(range.visibleRangeM);
    expectCovered(scene, exit);
  });

  it('keeps physical coverage and footprints invariant under scene-unit scaling', () => {
    const reference = setup(120000, 'medium', 70);
    update(reference);
    for (const scale of [0.01, 1000]) {
      const scene = setup(120000, 'medium', 70, scale);
      update(scene);
      for (let i = 0; i < scene.clouds.shadow.cascadeCount; ++i) {
        expect(texelM(scene, i)).toBeCloseTo(texelM(reference, i), 5);
      }
      for (const point of visibleReceivers(scene)) expectCovered(scene, point);
    }
  });

  it('does not mistake shadowFar for an automatic unshadowed-region cutoff', () => {
    const scene = setup(50);
    update(scene);
    const maps = scene.clouds.shadowMaps;
    const last = maps.cascades[maps.cascadeCount - 1];
    // Looking along the light axis keeps XY inside the last map even beyond
    // its far distance. This deliberately non-visible receiver demonstrates
    // why a future short local cap cannot rely on far alone as its fallback.
    const beyond = scene.camera.position.clone().addScaledVector(
      scene.camera.getWorldDirection(new Vector3()), maps.far * 1.1,
    );
    const clip = beyond.clone().applyMatrix4(last.matrix);
    expect(-beyond.clone().applyMatrix4(scene.camera.matrixWorldInverse).z).toBeGreaterThan(maps.far);
    expect(Math.abs(clip.x)).toBeLessThan(1);
    expect(Math.abs(clip.y)).toBeLessThan(1);
    expect(scene.clouds.cloudsPass.currentMaterial.fragmentShader).toContain("// Don't fade out the last cascade.");
  });

  it('changes cascade widths continuously through cloud heights and operating altitudes', () => {
    for (const altitude of [0, 50, 1000, 3000, 7500, 8000, 120000, 400000]) {
      const before = setup(Math.max(0, altitude - 0.01));
      const after = setup(altitude + 0.01);
      const a = update(before), b = update(after);
      expect(b.farM).toBeGreaterThanOrEqual(a.farM);
      for (let i = 0; i < before.clouds.shadow.cascadeCount; ++i) {
        const delta = Math.abs(texelM(after, i) / texelM(before, i) - 1);
        expect(delta).toBeLessThan(0.002);
      }
    }
  });

  it('updates after a preset/layer change, respects camera clipping, and leaves rendering policy intact', () => {
    const scene = setup(50, 'low');
    const projection = scene.camera.projectionMatrix.clone();
    const shader = scene.clouds.shadowPass.currentMaterial.fragmentShader;
    update(scene);
    const oldFar = scene.clouds.shadowMaps.far;
    scene.clouds.cloudLayers[1].height = 1500;
    scene.clouds.qualityPreset = 'medium';
    scene.clouds.shadow.farScale = 0.00001;
    update(scene);
    expect(scene.clouds.shadowMaps.far).toBeGreaterThan(oldFar);
    expect(scene.clouds.shadow.cascadeCount).toBe(3);
    expect(scene.clouds.shadow.mapSize.toArray()).toEqual([256, 256]);
    expect(scene.clouds.shadowPass.currentMaterial.fragmentShader).toBe(shader);
    expect(scene.camera.projectionMatrix.equals(projection)).toBe(true);
    scene.camera.far = 20000;
    scene.camera.updateProjectionMatrix();
    update(scene);
    expect(scene.clouds.shadowMaps.far).toBe(20000);
    expectCovered(scene, new Vector3());
  });

  it('handles disabled layers, sea level and one cascade without a singular map', () => {
    const scene = setup(0);
    for (const layer of scene.clouds.cloudLayers) layer.densityScale = 0;
    scene.clouds.shadow.cascadeCount = 1;
    update(scene);
    expect(scene.clouds.shadowMaps.far).toBeGreaterThan(scene.camera.near);
    expect(texelM(scene, 0)).toBeGreaterThan(0);
    expect(scene.clouds.shadowMaps.cascades[0].matrix.elements.every(Number.isFinite)).toBe(true);
  });

  it('rejects non-finite inputs before changing the shadow settings', () => {
    const scene = setup(50);
    const before = scene.clouds.shadow.maxFar;
    for (const options of [
      { cameraAltitudeM: NaN }, { cameraAltitudeM: Infinity },
      { cameraAltitudeM: 50, renderScaleMPerUnit: 0 }, { cameraAltitudeM: 50, earthRadiusM: -1 },
      { cameraAltitudeM: 50, renderScaleMPerUnit: Number.MIN_VALUE },
    ]) {
      expect(() => configureCloudShadowRange(scene.clouds, scene.camera, options)).toThrow(RangeError);
      expect(scene.clouds.shadow.maxFar).toBe(before);
    }
  });

  it('documents the remaining RGBA16F blocker with a real grazing shadow-shell ray', () => {
    const scene = setup(50);
    update(scene);
    expect(scene.clouds.shadowPass.outputBuffer.type).toBe(HalfFloatType);
    expect(scene.clouds.shadowPass.outputBuffer.format).toBe(RGBAFormat);
    const shader = scene.clouds.shadowPass.currentMaterial.fragmentShader;
    expect(shader).toContain('return vec4(frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail);');
    expect(shader).toContain('return vec4(maxRayDistance, 0.0, 0.0, 0.0);');
    expect(shader).toContain('rayFar = 1e6;');
    const maxHalf = DataUtils.fromHalfFloat(0x7bff);
    // The actual library atmosphere radius differs from the physical scene;
    // its altitude correction preserves these shell heights, in metres.
    const radius = scene.clouds.shadowPass.currentMaterial.uniforms.bottomRadius.value;
    const top = new Sphere(new Vector3(), radius + 3000);
    const bottom = new Sphere(new Vector3(), radius + 1000);
    const ray = new Ray(new Vector3(-1000000, radius + 999, 0), new Vector3(1, 0, 0));
    const entry = ray.intersectSphere(top, new Vector3())!;
    const exit = ray.intersectSphere(bottom, new Vector3())!;
    expect(entry.distanceTo(exit)).toBeGreaterThan(maxHalf * 2);
    // At zenith, however, the payload spans 2 km, not the 400 km camera range.
    const vertical = new Ray(new Vector3(0, radius + 400000, 0), new Vector3(0, -1, 0));
    expect(vertical.intersectSphere(top, new Vector3())!
      .distanceTo(vertical.intersectSphere(bottom, new Vector3())!)).toBeLessThan(maxHalf);
  });
});

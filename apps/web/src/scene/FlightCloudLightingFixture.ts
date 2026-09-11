import {
  AmbientLight, Color, DataArrayTexture, DirectionalLight, FloatType, HemisphereLight,
  InstancedMesh, LightProbe, LinearSRGBColorSpace, Matrix3, Matrix4, Mesh,
  MeshStandardMaterial, NearestFilter, PerspectiveCamera, PlaneGeometry, PointLight, RGBAFormat,
  Scene, Uniform, Vector2, Vector3, Vector4, WebGLRenderTarget, type WebGLRenderer,
} from 'three';
import { applyAirfieldSurface } from '../airfield/airfieldSurface';
import { createAirfieldSurfaceTextures } from '../airfield/airfieldSurfaceTextures';
import type { CloudConformanceResult } from './clouds/CloudConformanceFixture';
import type { CloudConformanceResources } from './clouds/CloudConformanceResources';
import { createWeatherBindingUniforms, createWeatherSnapshot } from './clouds/cloudWeather';
import { createFlightCloudLightingBridge } from './flightCloudLighting';
import { EARTH_RADIUS_M } from './sky/skyConfig';

type Lighting = 'direct' | 'point' | 'probe' | 'ambient' | 'hemisphere' | 'sky' | 'emission' | 'combined';

/** Actual StandardMaterial pixels: the oracle scales independently rendered
 * lighting contributions, never reimplements a BRDF or replaces shader output.
 * Only cache texels and weather inputs are synthetic. Everything, including
 * readback and cleanup, finishes inside a synchronous renderer state scope.
 */
export function runFlightCloudLightingConformance(
  renderer: WebGLRenderer, resources: CloudConformanceResources, tolerance = 1e-3,
): CloudConformanceResult[] {
  const cases: CloudConformanceResult[] = [];
  const record = (name: string, measured: readonly number[], expected: readonly number[], limit = tolerance) => {
    const finite = measured.length === expected.length && measured.every(Number.isFinite) && expected.every(Number.isFinite);
    const maxError = finite ? Math.max(...measured.map((value, i) => Math.abs(value - expected[i]!))) : Infinity;
    cases.push({ name: `flight-cloud-lighting-${name}`, measured, expected, maxError, passed: finite && maxError <= limit });
  };
  const ratio = (name: string, pixel: readonly number[], baseline: readonly number[], visibility = 1) => {
    // Alpha=1 proves a fragment was drawn. NaN/zero baselines cannot silently
    // pass a black output, even when a shader failed to compile or a mesh culled.
    record(name, [...pixel.slice(0, 3).map((value, i) => value / baseline[i]!), pixel[3]!],
      [visibility, visibility, visibility, 1]);
  };
  const gl = renderer.getContext();
  const recordErrors = (name: string) => {
    const errors: number[] = [];
    for (let i = 0; i < 16; i++) {
      const error = gl.getError();
      if (error === gl.NO_ERROR) break;
      errors.push(error);
    }
    record(`${name}-gl-errors`, [errors.length, ...errors], new Array(errors.length + 1).fill(0), 0);
  };
  const saved = {
    target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
    viewport: renderer.getViewport(new Vector4()), scissor: renderer.getScissor(new Vector4()),
    scissorTest: renderer.getScissorTest(), currentViewport: renderer.getCurrentViewport(new Vector4()),
    gpuViewport: new Vector4().fromArray(gl.getParameter(gl.VIEWPORT) as Int32Array),
    gpuScissor: new Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX) as Int32Array),
    gpuScissorTest: gl.isEnabled(gl.SCISSOR_TEST),
    clearColor: renderer.getClearColor(new Color()), clearAlpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear, toneMapping: renderer.toneMapping,
    xr: renderer.xr.enabled, shadows: renderer.shadowMap.enabled,
  };
  const bridge = createFlightCloudLightingBridge();
  const releases: (() => void)[] = [];
  const createMaterial = () => new MeshStandardMaterial({
    color: new Color().setRGB(0.35, 0.55, 0.75), roughness: 0.62, metalness: 0.2, toneMapped: false,
  });
  const material = createMaterial();
  const surface = createMaterial();
  const materials = [material, surface];
  const surfaceTextures = createAirfieldSurfaceTextures();
  const geometry = new PlaneGeometry(4, 4).rotateX(-Math.PI / 2);
  const mesh = new Mesh(geometry, material);
  const instances = new InstancedMesh(geometry, material, 1);
  instances.visible = false;
  const camera = new PerspectiveCamera(40, 1, 0.1, 20);
  camera.up.set(0, 0, -1);
  const direct = new DirectionalLight(0xffffff, 0);
  const point = new PointLight(0xffffff, 0);
  const ambient = new AmbientLight(0xffffff, 0);
  const hemisphere = new HemisphereLight(0xffffff, 0x404040, 0);
  hemisphere.position.set(0, 1, 0);
  const probe = new LightProbe();
  probe.sh.coefficients[0]!.set(0.6, 0.8, 1);
  const scene = new Scene();
  scene.add(mesh, instances, direct, direct.target, point, ambient, hemisphere, probe);
  const target = new WebGLRenderTarget(resources.size, resources.size, {
    type: FloatType, format: RGBAFormat, depthBuffer: false,
    minFilter: NearestFilter, magFilter: NearestFilter,
  });
  target.texture.colorSpace = LinearSRGBColorSpace;
  const cacheTexture = (sun: number, sky: number) => {
    const data = new Float32Array(8 * 8 * 4 * 4);
    data.fill(sun, 0, data.length / 2);
    data.fill(sky, data.length / 2);
    const texture = new DataArrayTexture(data, 8, 8, 4);
    texture.type = FloatType;
    texture.format = RGBAFormat;
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  };
  const cacheA = cacheTexture(0.25, 0.5);
  const cacheB = cacheTexture(0.75, 0.125);
  const frame = new Matrix3().set(0, 0, 1, 1, 0, 0, 0, 1, 0);
  const snapshot = createWeatherSnapshot({
    planetRadiusM: EARTH_RADIUS_M, visualTimeS: 0, sunDirectionECEF: [1, 0, 0],
  });
  const bindingsFor = (texture: DataArrayTexture) => ({
    ...createWeatherBindingUniforms(snapshot, {
      coverage: resources.zero2D, typeField: resources.zero2D,
      referenceField: resources.zero2D, noise: resources.zero3D,
    }),
    eveCloudPlanetRadiusM: new Uniform(EARTH_RADIUS_M),
    eveCloudAltitudeBoundsM: new Uniform(new Vector2(1000, 2000)),
    eveLightVolumeTexture: new Uniform(texture), eveLightFrame: new Uniform(frame.clone()),
    eveLightCapRadius: new Uniform(1), eveLightAltitudeBoundsM: new Uniform(new Vector2(0, 2000)),
    eveLightSlices: new Uniform(2), eveLightValid: new Uniform(1), eveLightGeneration: new Uniform(1),
  });
  const bindingsA = bindingsFor(cacheA);
  // Fresh Uniform objects AND different texture values expose stale borrowed
  // identities after clear/rebind on Three r170's per-material program cache.
  const bindingsB = bindingsFor(cacheB);
  const renderToECEF = new Matrix4().set(
    0, 100, 0, EARTH_RADIUS_M + 500,
    100, 0, 0, 0,
    0, 0, -100, 0,
    0, 0, 0, 1,
  );
  bridge.renderToECEF.copy(renderToECEF);
  const moveView = (y: number) => {
    camera.position.set(0, y + 4, 0);
    camera.lookAt(0, y, 0);
    direct.position.set(0, y + 10, 0);
    direct.target.position.set(0, y, 0);
    point.position.set(0, y + 3, 0);
  };
  moveView(0);
  const read = (lighting: Lighting, receiver = material): number[] => {
    // Keep every light present and change intensities only. A variant change
    // must not accidentally repair the uniform-lifetime regression under test.
    const all = lighting === 'combined';
    const sky = all || lighting === 'sky';
    direct.intensity = all || lighting === 'direct' ? 0.9 : 0;
    point.intensity = all || lighting === 'point' ? 1.8 : 0;
    probe.intensity = sky || lighting === 'probe' ? 0.65 : 0;
    ambient.intensity = sky || lighting === 'ambient' ? 0.35 : 0;
    hemisphere.intensity = sky || lighting === 'hemisphere' ? 0.45 : 0;
    receiver.emissive.setRGB(0.03125, 0.0625, 0.125);
    receiver.emissiveIntensity = all || lighting === 'emission' ? 1 : 0;
    mesh.material = instances.material = receiver;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixel = new Float32Array(4).fill(NaN);
    renderer.readRenderTargetPixels(target, resources.size >> 1, resources.size >> 1, 1, 1, pixel);
    return Array.from(pixel);
  };
  try {
    resources.draw(() => {
      try {
        recordErrors('entry');
        renderer.xr.enabled = false;
        renderer.shadowMap.enabled = false;
        const baseline = {
          direct: read('direct'), point: read('point'), probe: read('probe'), ambient: read('ambient'),
          hemisphere: read('hemisphere'), emission: read('emission'),
        };
        record('stock-contributions-are-lit', Object.values(baseline).map(pixel =>
          Number(pixel.every(Number.isFinite) && pixel.slice(0, 3).every(value => value > 1e-5) && pixel[3] === 1)),
        [1, 1, 1, 1, 1, 1], 0);
        const combined = (sun: number, sky: number) => baseline.direct.slice(0, 3).map((value, i) =>
          sun * value + sky * (baseline.probe[i]! + baseline.ambient[i]! + baseline.hemisphere[i]!)
          + baseline.point[i]! + baseline.emission[i]!);
        ratio('stock-contributions-add', read('combined'), combined(1, 1));
        const release = bridge.registerMaterial(material);
        releases.push(release);
        record('local-pbr-never-selects-library-lighting-mask',
          [Number(material.defines?.LIBRARY_LIGHTING === undefined)], [1], 0);
        // Compile while disabled, before any cloud bindings exist. No fixture
        // onBeforeCompile wrapper, forced cache key, or material replacement.
        bridge.setEnabled(false);
        ratio('disabled-before-bind-compiles', read('combined'), combined(1, 1));
        bridge.setBindings(bindingsA);
        bridge.setEnabled(true);
        for (const lighting of ['direct', 'point', 'probe', 'ambient', 'hemisphere', 'emission'] as const) {
          ratio(`bound-${lighting}-ratio`, read(lighting), baseline[lighting],
            lighting === 'direct' ? 0.25 : lighting === 'point' || lighting === 'emission' ? 1 : 0.5);
        }
        ratio('bound-combined', read('combined'), combined(0.25, 0.5));
        bridge.setEnabled(false);
        ratio('disabled-keeps-stock-lighting', read('combined'), combined(1, 1));
        bridge.setEnabled(true);
        ratio('reenabled-keeps-cache', read('combined'), combined(0.25, 0.5));
        bridge.clearBindings();
        ratio('clear-keeps-stock-lighting', read('combined'), combined(1, 1));
        bridge.setBindings(bindingsB);
        bridge.setEnabled(true);
        ratio('rebind-new-direct-uniform', read('direct'), baseline.direct, 0.75);
        ratio('rebind-new-sky-uniform', read('probe'), baseline.probe, 0.125);
        ratio('rebind-new-cache-combined', read('combined'), combined(0.75, 0.125));
        bridge.setBindings(bindingsA);
        ratio('rebind-original-cache', read('combined'), combined(0.25, 0.5));
        recordErrors('binding-lifetime');

        // Invalid, outside-disc and outside-altitude queries integrate the real
        // canonical zero-coverage medium, whose cloud visibility must be one.
        bindingsA.eveLightValid.value = 0;
        ratio('invalid-cache-empty-fallback', read('combined'), combined(1, 1));
        bindingsA.eveLightValid.value = 1;
        bindingsA.eveLightFrame.value.identity();
        ratio('outside-disc-empty-fallback', read('combined'), combined(1, 1));
        bindingsA.eveLightFrame.value.copy(frame);
        bindingsA.eveLightAltitudeBoundsM.value.set(2500, 3500);
        ratio('outside-altitude-empty-fallback', read('combined'), combined(1, 1));
        bindingsA.eveLightAltitudeBoundsM.value.set(0, 2000);

        mesh.position.y = 64;
        moveView(64);
        ratio('ordinary-uncompensated-move-misses-cache', read('combined'), combined(1, 1));
        bridge.renderToECEF.copy(renderToECEF).multiply(new Matrix4().makeTranslation(0, -64, 0));
        ratio('ordinary-rebase-preserves-lighting', read('combined'), combined(0.25, 0.5));
        mesh.visible = false;
        instances.visible = true;
        instances.position.y = 32;
        instances.rotation.y = 0.4;
        instances.setMatrixAt(0, new Matrix4().makeRotationY(0.3)
          .scale(new Vector3(1.5, 0.75, 1.25)).setPosition(0, 32, 0));
        instances.instanceMatrix.needsUpdate = true;
        ratio('instance-and-parent-transform-after-rebase', read('combined'), combined(0.25, 0.5));
        recordErrors('fallback-and-transforms');

        // Use the real airfield hook and maps on the upward instanced surface.
        // Its independent stock pixels prove the hook affects the visible face.
        applyAirfieldSurface(surface, 'pavement', surfaceTextures);
        const surfaceCompile = surface.onBeforeCompile;
        const surfaceKey = surface.customProgramCacheKey;
        const surfaceDirect = read('direct', surface);
        const surfacePoint = read('point', surface);
        const surfaceSky = read('sky', surface);
        const surfaceEmission = read('emission', surface);
        const surfaceCombined = (sun: number, sky: number) => surfaceDirect.slice(0, 3).map((value, i) =>
          sun * value + sky * surfaceSky[i]! + surfacePoint[i]! + surfaceEmission[i]!);
        record('airfield-hook-affects-pixels', [Number(surfaceDirect.slice(0, 3).some((value, i) =>
          Math.abs(value - baseline.direct[i]!) > 2 * tolerance))], [1], 0);
        const releaseSurface = bridge.registerMaterial(surface);
        releases.push(releaseSurface);
        ratio('airfield-direct-ratio', read('direct', surface), surfaceDirect, 0.25);
        ratio('airfield-sky-ratio', read('sky', surface), surfaceSky, 0.5);
        ratio('airfield-emission-unchanged', read('emission', surface), surfaceEmission);
        ratio('airfield-combined', read('combined', surface), surfaceCombined(0.25, 0.5));
        releaseSurface();
        record('airfield-hook-restored', [Number(surface.onBeforeCompile === surfaceCompile),
          Number(surface.customProgramCacheKey === surfaceKey)], [1, 1], 0);
        ratio('airfield-release-stock-pixels', read('combined', surface), surfaceCombined(1, 1));

        // Independent owners may unmount in either order. Releasing one owner
        // twice must leave the other owner active; the last release restores
        // both callbacks/defines and actual unattenuated StandardMaterial output.
        for (const order of [[0, 1], [1, 0]] as const) {
          const owned = createMaterial();
          materials.push(owned);
          const compile = owned.onBeforeCompile;
          const key = owned.customProgramCacheKey;
          const owners = [bridge.registerMaterial(owned), bridge.registerMaterial(owned)];
          releases.push(...owners);
          const name = `owners-release-${order.join('-')}`;
          ratio(`${name}-registered`, read('direct', owned), baseline.direct, 0.25);
          owners[order[0]]!();
          owners[order[0]]!();
          ratio(`${name}-one-owner-remains-after-repeat`, read('direct', owned), baseline.direct, 0.25);
          owners[order[1]]!();
          owners[order[1]]!();
          record(`${name}-callbacks-and-define-restored`, [Number(owned.onBeforeCompile === compile),
            Number(owned.customProgramCacheKey === key), Number(owned.defines?.LIBRARY_LIGHTING === undefined)], [1, 1, 1], 0);
          ratio(`${name}-last-owner-stock-pixels`, read('direct', owned), baseline.direct);
        }
        recordErrors('surface-and-registration');
      } finally {
        try {
          // Detach every borrowed Uniform/texture before disposing owned inputs.
          // resources' canonical weather textures remain owned by the parent.
          bridge.clearBindings();
          releases.forEach(release => release());
          renderer.setRenderTarget(null);
          target.dispose();
          instances.dispose();
          geometry.dispose();
          materials.forEach(value => value.dispose());
          surfaceTextures.dispose();
          cacheA.dispose();
          cacheB.dispose();
          scene.clear();
        } finally {
          renderer.xr.enabled = saved.xr;
          renderer.shadowMap.enabled = saved.shadows;
        }
      }
    });
  } finally {
    // draw() restores logical renderer state. Preserve the bound target's
    // potentially different physical viewport/scissor as ComposerDepth does.
    if (!renderer.getCurrentViewport(new Vector4()).equals(saved.currentViewport)) {
      renderer.setRenderTarget(saved.target, saved.face, saved.mip);
    }
    renderer.state.viewport(saved.gpuViewport);
    renderer.state.scissor(saved.gpuScissor);
    renderer.state.setScissorTest(saved.gpuScissorTest);
    recordErrors('cleanup');
  }
  record('renderer-state-restored', [
    Number(renderer.getRenderTarget() === saved.target), Number(renderer.getActiveCubeFace() === saved.face),
    Number(renderer.getActiveMipmapLevel() === saved.mip), Number(renderer.getViewport(new Vector4()).equals(saved.viewport)),
    Number(renderer.getScissor(new Vector4()).equals(saved.scissor)), Number(renderer.getScissorTest() === saved.scissorTest),
    Number(renderer.getCurrentViewport(new Vector4()).equals(saved.currentViewport)),
    Number(new Vector4().fromArray(gl.getParameter(gl.VIEWPORT) as Int32Array).equals(saved.gpuViewport)),
    Number(new Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX) as Int32Array).equals(saved.gpuScissor)),
    Number(gl.isEnabled(gl.SCISSOR_TEST) === saved.gpuScissorTest),
    Number(renderer.getClearColor(new Color()).equals(saved.clearColor)), Number(renderer.getClearAlpha() === saved.clearAlpha),
    Number(renderer.autoClear === saved.autoClear), Number(renderer.toneMapping === saved.toneMapping),
    Number(renderer.xr.enabled === saved.xr), Number(renderer.shadowMap.enabled === saved.shadows),
  ], new Array(16).fill(1), 0);
  return cases;
}

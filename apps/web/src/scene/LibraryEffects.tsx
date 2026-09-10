import { EveCloudSystem } from './clouds/EveCloudSystem';
import { EveAerialPerspectiveEffect } from './clouds/EveAerialPerspectiveEffect';
import { configureCloudSampling } from './libraryCloudSampling';
import { configureCloudLighting } from './libraryCloudLighting';
import { configureCloudTemporal } from './libraryCloudTemporal';
import { configureCloudFootprint, configureCloudNoiseMipmaps } from './libraryCloudFootprint';
import { CloudReprojectionFrame } from './libraryCloudReprojection';
import { StableLightingMaskPass } from './libraryLightingMask';
import { SurfaceNormalPass } from './librarySurfaceNormalPass';
import { configureCloudShadowStorage } from './libraryCloudShadowStorage';
import { configureCloudShadowRange, type CloudShadowRange } from './libraryCloudShadowRange';
import { configureGlobalWeatherTexture, useGlobalCloudWeather } from './libraryCloudWeather';
import { cloudShadowProbe, ShadowDiagnosticAerialEffect } from './libraryCloudShadowDiagnostics';
import { stabilizeCloudDepth, stabilizeCloudHeight } from './libraryDepth';
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { LightingMaskPass, PrecomputedTexturesLoader } from '@takram/three-atmosphere';
import { CloudsEffect } from '@takram/three-clouds';
import { DataTextureLoader, Ellipsoid, parseUint8Array, STBNLoader } from '@takram/three-geospatial';
import { EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { Data3DTexture, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Mesh, NoColorSpace, PerspectiveCamera, RedFormat, RepeatWrapping, ShaderMaterial, Texture, TextureLoader, Vector3 } from 'three';
import { EARTH_RADIUS_M, SKY_CONFIG } from './sky/skyConfig';
import { SUN_DIR } from './sun';
import { WorldFrame } from './worldFrame';
import { directionToECEF, updateWorldToECEF } from './libraryFrame';
import { installComposerPassTimings, renderTimings } from './renderTimings';
import { PROBE_CLOUDS, PROBE_DPR, PROBE_EXPOSURE, PROBE_QUALITY, PROBE_WEATHER, PROBE_WEATHER_STRUCTURE } from './renderProbeConfig';
import type { CloudLightQuality } from './clouds/cloudLightVolumeLayout';

export const libraryStatus = { state: 'loading', error: '', shadowRange: null as CloudShadowRange | null, shadowTexelM: [] as number[], lightingSelection: [0, 0, 0], eve: null as EveCloudSystem['status'] | null };
const ROOT = '/vendor/takram';
function publishComposerBufferContext(composer: EffectComposer): void {
  const targetContext = (target: typeof composer.inputBuffer) => ({
    size: [target.width, target.height] as const,
    format: target.texture.format,
    type: target.texture.type,
    samples: target.samples,
    colorSpace: target.texture.colorSpace,
  });
  renderTimings.setBufferContext({
    owner: 'effect-composer',
    input: targetContext(composer.inputBuffer),
    output: targetContext(composer.outputBuffer),
  });
}
export interface LibraryEffectsProps {
  readonly worldFrame: WorldFrame;
  readonly exposureRef: { current: number };
  /** Omitted preserves SceneRoot's existing query-selected cloud backend. */
  readonly cloudSystem?: 'legacy' | 'eve';
  /** Omitted preserves the existing diagnostic query default. */
  readonly quality?: CloudLightQuality;
  /** Omitted preserves the existing diagnostic query default. */
  readonly exposure?: number;
  /** Used for render diagnostics; the Canvas remains the DPR owner. */
  readonly dpr?: number;
}

export function LibraryEffects({ worldFrame, exposureRef, cloudSystem, quality, exposure, dpr }: LibraryEffectsProps) {
  const { gl, scene, camera, size, invalidate } = useThree();
  const query = new URLSearchParams(window.location.search);
  const selectedCloudSystem = cloudSystem ?? (query.get('cloudSystem') === 'eve' ? 'eve' : 'legacy');
  const selectedQuality = quality ?? PROBE_QUALITY;
  const selectedExposure = exposure ?? PROBE_EXPOSURE;
  const selectedDpr = dpr ?? PROBE_DPR;
  const latestSize = useRef(size);
  const cloudFrame = useRef(new CloudReprojectionFrame());
  const cameraECEF = useRef(new Vector3());
  latestSize.current = size;
  const live = useRef<{ composer: EffectComposer; aerial: ShadowDiagnosticAerialEffect; clouds?: CloudsEffect; eve?: EveCloudSystem; mask: LightingMaskPass; originalShadow?: { maxFar: number | null; splitLambda: number }; firstUsePending: boolean }>();
  useEffect(() => {
    let disposed = false;
    cloudFrame.current = new CloudReprojectionFrame();
    libraryStatus.state = 'loading'; libraryStatus.error = '';
    const owned = new Set<Texture>();
    const own = <T extends Texture>(texture: T): T => {
      if (disposed) texture.dispose(); else owned.add(texture);
      return texture;
    };
    const composerSetupStartedAt = renderTimings.start('composer.setup');
    const composer = new EffectComposer(gl, { frameBufferType: HalfFloatType, multisampling: 0 });
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    const normals = new SurfaceNormalPass(scene, camera);
    composer.addPass(normals);
    const mask = new StableLightingMaskPass(scene, camera);
    composer.addPass(mask);
    const ellipsoid = new Ellipsoid(EARTH_RADIUS_M, EARTH_RADIUS_M, EARTH_RADIUS_M);
    const stage = new URLSearchParams(window.location.search).get('stage') ?? 'full';
    const eveEnabled = selectedCloudSystem === 'eve';
    const eve = PROBE_CLOUDS && eveEnabled ? new EveCloudSystem(camera, selectedQuality, directionToECEF(SUN_DIR)) : undefined;
    const invalidateEve = () => eve?.invalidateGraphicsContext();
    gl.domElement.addEventListener('webglcontextlost', invalidateEve);
    gl.domElement.addEventListener('webglcontextrestored', invalidateEve);
    libraryStatus.eve = eve?.status ?? null;
    const Aerial = eve ? EveAerialPerspectiveEffect : ShadowDiagnosticAerialEffect;
    const aerial = new Aerial(camera, {
      ellipsoid, correctAltitude: true, correctGeometricError: true,
      transmittance: stage === 'full', inscatter: stage === 'full',
      normalBuffer: normals.texture, reconstructNormal: false, sunLight: true, skyLight: true, sky: true, moon: false,
    });
    if (eve && aerial instanceof EveAerialPerspectiveEffect) aerial.installCloudLighting(eve.lightingUniforms);
    aerial.normalBuffer = normals.texture; // The pinned constructor does not set HAS_NORMALS.
    aerial.sunDirection.copy(directionToECEF(SUN_DIR));
    aerial.lightingMask = { map: mask.texture, channel: 'r' };
    const clouds = PROBE_CLOUDS && !eve ? new CloudsEffect(camera) : undefined;
    if (clouds) {
      const cloudSetupStartedAt = renderTimings.start('cloud.setup');
      try {
        clouds.qualityPreset = selectedQuality;
        configureCloudShadowStorage(clouds);
        stabilizeCloudDepth(clouds);
        stabilizeCloudHeight(clouds);
        if (PROBE_WEATHER === 'global') useGlobalCloudWeather(clouds, { mode: PROBE_WEATHER_STRUCTURE });
        const diagnostics = new URLSearchParams(window.location.search);
        if (diagnostics.get('sampling') !== 'legacy') configureCloudSampling(clouds);
        if (diagnostics.get('temporal') === 'taa') { clouds.temporalUpscale = false; clouds.resolutionScale = diagnostics.get('resolution') === 'quarter' ? 0.25 : 0.5; }
        if (diagnostics.get('detail') === '0') clouds.shapeDetail = false;
        if (diagnostics.get('shape') === '0') for (const layer of clouds.cloudLayers) layer.shapeAmount = 0;
        if (diagnostics.get('accurateLight') === '1') clouds.clouds.accurateSunSkyLight = true;
        if (diagnostics.get('cloudLight') === 'ray') configureCloudLighting(clouds);
        if (diagnostics.get('history') !== 'legacy') configureCloudTemporal(clouds, diagnostics.get('history') === 'stable');
        if (diagnostics.get('powder') === '0') clouds.powderScale = 0;
        if (diagnostics.get('footprint') !== 'legacy') configureCloudFootprint(clouds);
        clouds.ellipsoid = ellipsoid;
        clouds.sunDirection.copy(aerial.sunDirection);
        clouds.skipRendering = true; // Aerial effect composites its premultiplied overlay exactly once.
        clouds.events.addEventListener('change', () => {
          aerial.overlay = clouds.atmosphereOverlay;
          aerial.shadow = clouds.atmosphereShadow;
          aerial.shadowLength = clouds.atmosphereShadowLength;
        });
      } finally {
        renderTimings.end('cloud.setup', cloudSetupStartedAt);
      }
    }
    if (eve) eve.effect.events.addEventListener('change', () => {
      aerial.overlay = eve.effect.atmosphereOverlay;
    });
    const cloudEffect = eve?.effect ?? clouds;
    const cloudPass = cloudEffect ? new EffectPass(camera, cloudEffect) : undefined;
    if (cloudPass) composer.addPass(cloudPass);
    const atmosphereToneMappingPass = new EffectPass(camera, ...(stage === 'albedo' ? [] : [aerial]),
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    composer.addPass(atmosphereToneMappingPass);
    const passTimingCleanup = installComposerPassTimings(composer, renderTimings, [
      [renderPass, 'composer.pass.renderScene'],
      [normals, 'composer.pass.surfaceNormals'],
      [mask, 'composer.pass.lightingMask'],
      ...(cloudPass ? [[cloudPass, 'composer.pass.clouds'] as const] : []),
      [atmosphereToneMappingPass, 'composer.pass.atmosphereToneMapping'],
    ]);
    renderTimings.end('composer.setup', composerSetupStartedAt);
    publishComposerBufferContext(composer);
    const textures = new PrecomputedTexturesLoader({ format: 'binary' }).setType(gl).loadAsync(`${ROOT}/atmosphere`).then(value => { Object.values(value).forEach(texture => { if (texture) own(texture); }); return value; });
    const stbn = new STBNLoader().loadAsync(`${ROOT}/stbn.bin`).then(own);
    const noise3D = (name: string, n: number) => new DataTextureLoader(Data3DTexture, parseUint8Array, {
      width: n, height: n, depth: n, format: RedFormat,
      minFilter: LinearFilter, magFilter: LinearFilter,
      wrapS: RepeatWrapping, wrapT: RepeatWrapping, wrapR: RepeatWrapping,
    }).loadAsync(`${ROOT}/clouds/${name}.bin`).then(texture => new URLSearchParams(window.location.search).get('footprint') !== 'legacy' ? configureCloudNoiseMipmaps(texture) : texture).then(own);
    const noise2D = async (name: string) => {
      const texture = await new TextureLoader().loadAsync(`${ROOT}/clouds/${name}.png`);
      texture.minFilter = LinearMipmapLinearFilter; texture.magFilter = LinearFilter;
      texture.wrapS = texture.wrapT = RepeatWrapping; texture.colorSpace = NoColorSpace;
      return own(texture);
    };
    // Attach rejection handling immediately: StrictMode/HMR can cancel weather
    // before the atmosphere LUT promise settles.
    const eveAssets = eve?.load().then(() => null, error => error);
    Promise.all([textures, stbn, ...(clouds ? [PROBE_WEATHER === 'global' ? new TextureLoader().loadAsync('/vendor/earth-weather/global-coverage.png').then(own).then(texture => disposed ? texture : configureGlobalWeatherTexture(texture, { mode: PROBE_WEATHER_STRUCTURE })).then(own) : noise2D('local_weather'), noise2D('turbulence'), noise3D('shape', 128), noise3D('shape_detail', 32)] : [])])
      .then(async ([lut, blueNoise, weather, turbulence, shape, detail]) => {
        const eveAssetError = await eveAssets;
        if (eveAssetError && !disposed) throw eveAssetError;
        // Tuple spread's heterogeneous inference is narrowed at this isolated loader boundary.
        const luts = lut as Awaited<typeof textures>;
        if (disposed) return;
        const assetAssignmentStartedAt = renderTimings.start('cloud.assetsAssignmentCpuWall');
        try {
          Object.assign(aerial, luts); aerial.stbnTexture = blueNoise as Data3DTexture;
          if (eve) { Object.assign(eve.effect, luts); eve.effect.stbnTexture = blueNoise as Data3DTexture; }
          if (clouds) {
            Object.assign(clouds, luts);
            clouds.stbnTexture = blueNoise as Data3DTexture;
            clouds.localWeatherTexture = weather as Awaited<ReturnType<typeof noise2D>>;
            clouds.turbulenceTexture = turbulence as Awaited<ReturnType<typeof noise2D>>;
            clouds.shapeTexture = shape as Data3DTexture; clouds.shapeDetailTexture = detail as Data3DTexture;
          }
        } finally {
          renderTimings.end('cloud.assetsAssignmentCpuWall', assetAssignmentStartedAt);
        }
        composer.setSize(latestSize.current.width, latestSize.current.height);
        publishComposerBufferContext(composer);
        live.current = { composer, aerial, clouds, eve, mask, originalShadow: clouds ? { maxFar: clouds.shadow.maxFar, splitLambda: clouds.shadow.splitLambda } : undefined, firstUsePending: true };
        libraryStatus.state = 'ready';
        invalidate(); // A paused flight renders on demand; show completed asset loading too.
      }).catch(error => { if (!disposed) { libraryStatus.state = 'failed'; libraryStatus.error = String(error); console.error(error); } });
    return () => { disposed = true; gl.domElement.removeEventListener('webglcontextlost', invalidateEve); gl.domElement.removeEventListener('webglcontextrestored', invalidateEve); eve?.dispose(); live.current = undefined; passTimingCleanup(); renderTimings.detachRenderer(gl); composer.dispose(); owned.forEach(texture => texture.dispose()); owned.clear(); };
  }, [gl, scene, camera, worldFrame, selectedCloudSystem, selectedQuality, invalidate]);
  useEffect(() => {
    const composer = live.current?.composer;
    if (composer === undefined) return;
    composer.setSize(size.width, size.height);
    publishComposerBufferContext(composer);
  }, [size]);
  useFrame((_, delta) => {
    exposureRef.current = selectedExposure;
    gl.toneMappingExposure = selectedExposure;
    renderTimings.updateRendererContext(gl, 'library', selectedDpr);
    renderTimings.beginFrame();
    const value = live.current;
    if (!value) { gl.render(scene, camera); return; }
    value.aerial.shadowStrength.value = cloudShadowProbe.mode === 'off' ? 0 : 1;
    value.aerial.shadowDiagnostic.value = ({ mask: 1, lighting: 2, normals: 3 } as Record<string, number>)[cloudShadowProbe.mode] ?? 0;
    value.aerial.cloudOverlay.value = cloudShadowProbe.overlay ? 1 : 0;
    value.aerial.waterLighting.value = cloudShadowProbe.waterReflections ? 1 : 0;
    updateWorldToECEF(worldFrame, value.aerial.worldToECEFMatrix);
    if (value.clouds) value.clouds.worldToECEFMatrix.copy(value.aerial.worldToECEFMatrix);
    value.eve?.beforeRender(gl, value.aerial.worldToECEFMatrix, worldFrame.anchor, SKY_CONFIG.renderScaleMPerUnit);
    if (value.clouds) {
      const shadowRangeStartedAt = renderTimings.start('cloud.schedule.shadowRange');
      try {
        if (camera instanceof PerspectiveCamera && cloudShadowProbe.range === 'fitted') {
          camera.getWorldPosition(cameraECEF.current).applyMatrix4(value.clouds.worldToECEFMatrix);
          libraryStatus.shadowRange = configureCloudShadowRange(value.clouds, camera, {
            cameraAltitudeM: cameraECEF.current.length() - EARTH_RADIUS_M,
          });
        } else if (value.originalShadow) {
          Object.assign(value.clouds.shadow, value.originalShadow);
          libraryStatus.shadowRange = null;
        }
      } finally {
        renderTimings.end('cloud.schedule.shadowRange', shadowRangeStartedAt);
      }
    }
    if (value.clouds) {
      const beforeStartedAt = renderTimings.start('cloud.schedule.reprojectionBefore');
      try {
        cloudFrame.current.beforeRender(value.clouds, worldFrame.anchor, SKY_CONFIG.renderScaleMPerUnit);
      } finally {
        renderTimings.end('cloud.schedule.reprojectionBefore', beforeStartedAt);
      }
    }
    value.mask.selection.clear();
    const maskStartedAt = renderTimings.start('cloud.schedule.lightingMask');
    let lit = 0, excluded = 0;
    try {
      scene.traverse(object => {
        if (!(object instanceof Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (materials.every(material => !(material instanceof ShaderMaterial) || !material.defines.LIBRARY_LIGHTING)) { value.mask.selection.add(object); excluded++; }
        else lit++;
      });
    } finally {
      renderTimings.end('cloud.schedule.lightingMask', maskStartedAt);
    }
    libraryStatus.lightingSelection = [lit, excluded, value.mask.selectionLayer];
    const renderStartedAt = renderTimings.start('composer.renderCpuWall');
    const firstUseStartedAt = value.firstUsePending ? renderTimings.start('composer.firstUseCpuWall') : -1;
    try {
      value.composer.render(delta);
      value.eve?.afterRender(worldFrame.anchor);
    } finally {
      renderTimings.end('composer.renderCpuWall', renderStartedAt);
      if (value.firstUsePending) {
        renderTimings.end('composer.firstUseCpuWall', firstUseStartedAt);
        value.firstUsePending = false;
      }
    }
    if (value.clouds) libraryStatus.shadowTexelM = value.clouds.shadowMaps.cascades.map(cascade =>
      2 / cascade.projectionMatrix.elements[0] / value.clouds!.shadow.mapSize.x * SKY_CONFIG.renderScaleMPerUnit);
    const afterStartedAt = renderTimings.start('cloud.schedule.reprojectionAfter');
    try {
      cloudFrame.current.afterRender(camera, worldFrame.anchor);
    } finally {
      renderTimings.end('cloud.schedule.reprojectionAfter', afterStartedAt);
    }
  }, 1);
  return null;
}

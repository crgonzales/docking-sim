import { VolumetricCloudSystem } from './clouds/VolumetricCloudSystem';
import { resolveCloudSystem } from './clouds/cloudSystemSelection';
import { VolumetricAerialPerspectiveEffect } from './clouds/VolumetricAerialPerspectiveEffect';
import { configureCloudSampling } from './libraryCloudSampling';
import { configureCloudLighting } from './libraryCloudLighting';
import { configureCloudTemporal } from './libraryCloudTemporal';
import { configureCloudFootprint, configureCloudNoiseMipmaps } from './libraryCloudFootprint';
import { CloudReprojectionFrame } from './libraryCloudReprojection';
import { StableLightingMaskPass } from './libraryLightingMask';
import { SurfaceNormalPass } from './librarySurfaceNormalPass';
import { createSceneSmaa, onSceneSmaaLoad, sceneSmaaReady } from './librarySmaa';
import { SpacecraftExhaustPass } from './SpacecraftExhaustPass';
import { isolateComposerDepthStorage } from './libraryComposerDepth';
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
import { EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { Data3DTexture, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Mesh, ShaderMaterial, NoColorSpace, PerspectiveCamera, RedFormat, RepeatWrapping, Texture, TextureLoader, Vector3 } from 'three';
import { EARTH_RADIUS_M, SKY_CONFIG } from './sky/skyConfig';
import { SUN_DIR } from './sun';
import { WorldFrame } from './worldFrame';
import { directionToECEF, updateWorldToECEF } from './libraryFrame';
import { installComposerPassTimings, renderTimings } from './renderTimings';
import { PROBE_CLOUDS, PROBE_DPR, PROBE_EXPOSURE, PROBE_QUALITY, PROBE_WEATHER, PROBE_WEATHER_STRUCTURE } from './renderProbeConfig';
import type { CloudLightQuality } from './clouds/cloudLightVolumeLayout';
import type { FlightEnvironmentSource } from '../flight/flightEnvironment';
import type { FlightCloudLightingBridge } from './flightCloudLighting';

export const libraryStatus = {
  state: 'loading', error: '', shadowRange: null as CloudShadowRange | null, shadowTexelM: [] as number[],
  lightingSelection: [0, 0, 0], volumetric: null as VolumetricCloudSystem['status'] | null,
  graphics: {
    preset: null as 'balanced' | 'high' | null,
    quality: null as CloudLightQuality | null,
    requestedDpr: null as number | null,
    effectiveDpr: null as number | null,
    drawingBuffer: [0, 0] as [number, number],
    scenePixels: 0,
    maxTextureSize: null as number | null,
    smaa: { enabled: false, ready: false, preset: null as 'medium' | 'high' | null },
    passes: [] as { name: string; enabled: boolean; swap: boolean; screen: boolean }[],
  },
};
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
  readonly cloudSystem?: 'legacy' | 'volumetric';
  /** Omitted preserves the existing diagnostic query default. */
  readonly quality?: CloudLightQuality;
  /** Omitted preserves the existing diagnostic query default. */
  readonly exposure?: number;
  /** Used for render diagnostics; the Canvas remains the DPR owner. */
  readonly dpr?: number;
  /** Optional FLIGHT graphics label for evidence; omitted for SceneRoot. */
  readonly graphicsPreset?: 'balanced' | 'high';
  /** Omitted uses high at every DPR; explicit medium/disabled requests are preserved. */
  readonly smaa?: { readonly enabled?: boolean; readonly preset: 'medium' | 'high' };
  /** Optional FLIGHT-owned daylight state; omitted preserves static SceneRoot lighting. */
  readonly environment?: FlightEnvironmentSource;
  /** Borrowed LUT for local PBR sunlight; this composer retains ownership. */
  readonly sunTransmittanceRef?: { current: Texture | null };
  /** Borrowed LUT for the FlightLighting sky probe; this composer retains ownership. */
  readonly skyIrradianceRef?: { current: Texture | null };
  /** Stable FlightScene-owned local PBR cloud hook. */
  readonly cloudLighting?: FlightCloudLightingBridge;
}

export function LibraryEffects({ worldFrame, exposureRef, cloudSystem, quality, exposure, dpr, graphicsPreset, smaa, environment, sunTransmittanceRef, skyIrradianceRef, cloudLighting }: LibraryEffectsProps) {
  const { gl, scene, camera, size, viewport, invalidate } = useThree();
  const query = new URLSearchParams(window.location.search);
  const selectedCloudSystem = resolveCloudSystem(cloudSystem ?? query.get('cloudSystem'));
  const selectedQuality = quality ?? PROBE_QUALITY;
  const selectedExposure = exposure ?? PROBE_EXPOSURE;
  const selectedDpr = dpr ?? PROBE_DPR;
  const selectedSmaaPreset = smaa?.enabled === false || ((import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV && query.get('sceneAA') === 'off')
    ? null : smaa?.preset ?? 'high';
  const hasSmaa = selectedSmaaPreset !== null;
  const selectedSmaaPresetRef = useRef(selectedSmaaPreset);
  selectedSmaaPresetRef.current = selectedSmaaPreset;
  const latestSize = useRef(size);
  const cloudFrame = useRef(new CloudReprojectionFrame());
  const cameraECEF = useRef(new Vector3());
  const sunRender = useRef(new Vector3());
  const sunECEF = useRef(new Vector3());
  const environmentDiscontinuity = useRef(environment?.state.discontinuityRevision ?? 0);
  latestSize.current = size;
  const live = useRef<{ composer: EffectComposer; aerial: ShadowDiagnosticAerialEffect; clouds?: CloudsEffect; volumetric?: VolumetricCloudSystem; mask: LightingMaskPass; smaa?: SMAAEffect; smaaPass?: EffectPass; originalShadow?: { maxFar: number | null; splitLambda: number }; firstUsePending: boolean }>();
  useEffect(() => {
    let disposed = false;
    cloudLighting?.clearBindings();
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
    const volumetricEnabled = selectedCloudSystem === 'volumetric';
    const initialSunRender = environment
      ? new Vector3().fromArray(environment.state.sunDirection)
      : SUN_DIR.clone();
    const initialSunECEF = directionToECEF(initialSunRender);
    const volumetric = PROBE_CLOUDS && volumetricEnabled ? new VolumetricCloudSystem(camera, selectedQuality, initialSunECEF) : undefined;
    const invalidateVolumetric = () => volumetric?.invalidateGraphicsContext();
    gl.domElement.addEventListener('webglcontextlost', invalidateVolumetric);
    gl.domElement.addEventListener('webglcontextrestored', invalidateVolumetric);
    libraryStatus.volumetric = volumetric?.status ?? null;
    const Aerial = volumetric ? VolumetricAerialPerspectiveEffect : ShadowDiagnosticAerialEffect;
    const aerial = new Aerial(camera, {
      ellipsoid, correctAltitude: true, correctGeometricError: true,
      transmittance: stage === 'full', inscatter: stage === 'full',
      normalBuffer: normals.texture, reconstructNormal: false, sunLight: true, skyLight: true, sky: true, moon: false,
    });
    if (volumetric && aerial instanceof VolumetricAerialPerspectiveEffect) {
      aerial.installCloudLighting(volumetric.lightingUniforms);
      aerial.cloudOverlayDepthSource = () => volumetric.effect.cloudsPass.outputDepthBuffer;
    }
    aerial.normalBuffer = normals.texture; // The pinned constructor does not set HAS_NORMALS.
    aerial.sunDirection.copy(initialSunECEF);
    aerial.lightingMask = { map: mask.texture, channel: 'r' };
    const clouds = PROBE_CLOUDS && !volumetric ? new CloudsEffect(camera) : undefined;
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
    if (volumetric) volumetric.effect.events.addEventListener('change', () => {
      aerial.overlay = volumetric.effect.atmosphereOverlay;
    });
    const cloudEffect = volumetric?.effect ?? clouds;
    const cloudPass = cloudEffect ? new EffectPass(camera, cloudEffect) : undefined;
    if (cloudPass) composer.addPass(cloudPass);
    const atmospherePass = stage === 'albedo' ? undefined : new EffectPass(camera, aerial);
    if (atmospherePass) composer.addPass(atmospherePass);
    const exhaustPass = new SpacecraftExhaustPass(scene, camera);
    composer.addPass(exhaustPass);
    const toneMappingPass = new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    composer.addPass(toneMappingPass);
    // Keep SMAA in a separate final pass so its edge detector receives the
    // already-tonemapped image rather than the atmosphere pass's HDR input.
    const smaaEffect = selectedSmaaPresetRef.current === null ? undefined : createSceneSmaa(selectedSmaaPresetRef.current);
    // Lookup images load independently of the atmosphere assets. A paused view
    // needs a new frame when they arrive, otherwise its first image can lack AA.
    const removeSmaaLoad = smaaEffect ? onSceneSmaaLoad(smaaEffect, () => invalidate()) : undefined;
    const smaaPass = smaaEffect ? new EffectPass(camera, smaaEffect) : undefined;
    if (smaaPass) smaaPass.name = 'SceneSmaaPass';
    if (smaaPass) composer.addPass(smaaPass);
    isolateComposerDepthStorage(composer);
    const passTimingCleanup = installComposerPassTimings(composer, renderTimings, [
      [renderPass, 'composer.pass.renderScene'],
      [normals, 'composer.pass.surfaceNormals'],
      [mask, 'composer.pass.lightingMask'],
      ...(cloudPass ? [[cloudPass, 'composer.pass.clouds'] as const] : []),
      ...(atmospherePass ? [[atmospherePass, 'composer.pass.atmosphere'] as const] : []),
      [exhaustPass, 'composer.pass.exhaust'],
      [toneMappingPass, 'composer.pass.toneMapping'],
      ...(smaaPass ? [[smaaPass, 'composer.pass.finalSmaa'] as const] : []),
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
    const volumetricAssets = volumetric?.load().then(() => null, error => error);
    Promise.all([textures, stbn, ...(clouds ? [PROBE_WEATHER === 'global' ? new TextureLoader().loadAsync('/vendor/earth-weather/global-coverage.png').then(own).then(texture => disposed ? texture : configureGlobalWeatherTexture(texture, { mode: PROBE_WEATHER_STRUCTURE })).then(own) : noise2D('local_weather'), noise2D('turbulence'), noise3D('shape', 128), noise3D('shape_detail', 32)] : [])])
      .then(async ([lut, blueNoise, weather, turbulence, shape, detail]) => {
        const volumetricAssetError = await volumetricAssets;
        if (volumetricAssetError && !disposed) throw volumetricAssetError;
        // Tuple spread's heterogeneous inference is narrowed at this isolated loader boundary.
        const luts = lut as Awaited<typeof textures>;
        if (disposed) return;
        const assetAssignmentStartedAt = renderTimings.start('cloud.assetsAssignmentCpuWall');
        try {
          Object.assign(aerial, luts); aerial.stbnTexture = blueNoise as Data3DTexture;
          if (sunTransmittanceRef) sunTransmittanceRef.current = luts.transmittanceTexture;
          if (skyIrradianceRef) skyIrradianceRef.current = luts.irradianceTexture;
          if (volumetric) { Object.assign(volumetric.effect, luts); volumetric.effect.stbnTexture = blueNoise as Data3DTexture; }
          if (clouds) {
            Object.assign(clouds, luts);
            clouds.stbnTexture = blueNoise as Data3DTexture;
            clouds.localWeatherTexture = weather as Awaited<ReturnType<typeof noise2D>>;
            clouds.turbulenceTexture = turbulence as Awaited<ReturnType<typeof noise2D>>;
            clouds.shapeTexture = shape as Data3DTexture; clouds.shapeDetailTexture = detail as Data3DTexture;
          }
          if (cloudLighting && volumetric) {
            // Volumetric.load() and the atmosphere LUT promise have both settled.
            // Borrow the exact live Uniform instances; the bridge owns no
            // cloud texture or lighting-cache resource.
            cloudLighting.setBindings(volumetric.lightingUniforms);
            cloudLighting.setEnabled(true);
          }
        } finally {
          renderTimings.end('cloud.assetsAssignmentCpuWall', assetAssignmentStartedAt);
        }
        smaaEffect?.applyPreset(selectedSmaaPresetRef.current === 'high' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM);
        composer.setSize(latestSize.current.width, latestSize.current.height, false);
        publishComposerBufferContext(composer);
        live.current = { composer, aerial, clouds, volumetric, mask, smaa: smaaEffect, smaaPass, originalShadow: clouds ? { maxFar: clouds.shadow.maxFar, splitLambda: clouds.shadow.splitLambda } : undefined, firstUsePending: true };
        libraryStatus.state = 'ready';
        invalidate(); // A paused flight renders on demand; show completed asset loading too.
      }).catch(error => { if (!disposed) { libraryStatus.state = 'failed'; libraryStatus.error = String(error); console.error(error); } });
    return () => { disposed = true; if (sunTransmittanceRef) sunTransmittanceRef.current = null; if (skyIrradianceRef) skyIrradianceRef.current = null; cloudLighting?.clearBindings(); gl.domElement.removeEventListener('webglcontextlost', invalidateVolumetric); gl.domElement.removeEventListener('webglcontextrestored', invalidateVolumetric); removeSmaaLoad?.(); volumetric?.dispose(); live.current = undefined; passTimingCleanup(); renderTimings.detachRenderer(gl); composer.dispose(); owned.forEach(texture => texture.dispose()); owned.clear(); };
  }, [gl, scene, camera, worldFrame, selectedCloudSystem, selectedQuality, hasSmaa, invalidate, environment, sunTransmittanceRef, skyIrradianceRef, cloudLighting]);
  useEffect(() => {
    const value = live.current;
    if (!value) return;
    if (selectedSmaaPreset === null) {
      if (value.smaaPass) value.smaaPass.enabled = false;
    } else if (value.smaa) {
      value.smaa.applyPreset(selectedSmaaPreset === 'high' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM);
      if (value.smaaPass) value.smaaPass.enabled = true;
    }
    invalidate();
  }, [invalidate, selectedSmaaPreset]);
  useEffect(() => {
    const composer = live.current?.composer;
    if (composer === undefined) return;
    composer.setSize(size.width, size.height, false);
    publishComposerBufferContext(composer);
  }, [size.height, size.width, viewport.dpr]);
  useFrame((_, delta) => {
    exposureRef.current = selectedExposure;
    gl.toneMappingExposure = selectedExposure;
    const effectiveDpr = gl.getPixelRatio();
    renderTimings.updateRendererContext(gl, 'library', effectiveDpr);
    renderTimings.beginFrame();
    libraryStatus.graphics = {
      preset: graphicsPreset ?? null,
      quality: selectedQuality,
      requestedDpr: selectedDpr,
      effectiveDpr,
      drawingBuffer: [gl.domElement.width, gl.domElement.height] as [number, number],
      scenePixels: gl.domElement.width * gl.domElement.height,
      maxTextureSize: gl.capabilities.maxTextureSize,
      smaa: { enabled: live.current?.smaaPass?.enabled === true, ready: sceneSmaaReady(live.current?.smaa), preset: selectedSmaaPreset },
      passes: live.current?.composer.passes.map(pass => ({ name: pass.name, enabled: pass.enabled,
        swap: pass.needsSwap, screen: pass.renderToScreen })) ?? [],
    };
    const value = live.current;
    if (!value) { gl.render(scene, camera); return; }
    cloudLighting?.setEnabled(value.volumetric !== undefined && cloudShadowProbe.mode !== 'off');
    value.aerial.shadowStrength.value = cloudShadowProbe.mode === 'off' ? 0 : 1;
    value.aerial.shadowDiagnostic.value = ({ mask: 1, lighting: 2, normals: 3 } as Record<string, number>)[cloudShadowProbe.mode] ?? 0;
    value.aerial.cloudOverlay.value = cloudShadowProbe.overlay ? 1 : 0;
    value.aerial.waterLighting.value = cloudShadowProbe.waterReflections ? 1 : 0;
    updateWorldToECEF(worldFrame, value.aerial.worldToECEFMatrix);
    if (value.clouds) value.clouds.worldToECEFMatrix.copy(value.aerial.worldToECEFMatrix);
    let environmentSunDelta = 0;
    if (environment) {
      const state = environment.state;
      sunRender.current.fromArray(state.sunDirection);
      sunECEF.current.set(sunRender.current.x, -sunRender.current.z, sunRender.current.y);
      const discontinuity = state.discontinuityRevision !== environmentDiscontinuity.current;
      environmentDiscontinuity.current = state.discontinuityRevision;
      value.aerial.sunDirection.copy(sunECEF.current);
      value.clouds?.sunDirection.copy(sunECEF.current);
      // Weather time owns the one discontinuity invalidation; daylight itself
      // remains a live light input without restarting compatible history.
      value.volumetric?.setSunDirection(sunECEF.current, false);
      value.volumetric?.setEnvironmentTime(state.timeSeconds, discontinuity);
      environmentSunDelta = state.paused ? 0 : delta;
    }
    value.volumetric?.beforeRender(gl, value.aerial.worldToECEFMatrix, worldFrame.anchor, SKY_CONFIG.renderScaleMPerUnit, environmentSunDelta);
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
        // No opaque mask for alpha-only exhaust/decals: its override material
        // would mask the planet through the otherwise invisible plume bounds.
        if (materials.every(material => material.transparent && !material.depthWrite)) return;
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
      value.volumetric?.afterRender(worldFrame.anchor);
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

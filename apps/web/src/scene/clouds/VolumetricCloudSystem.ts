import { Ellipsoid } from '@takram/three-geospatial';
import { Camera, Matrix4, Quaternion, Uniform, Vector2, Vector3, type WebGLRenderer } from 'three';
import { EARTH_RADIUS_M } from '../sky/skyConfig';
import { CloudReprojectionFrame } from '../libraryCloudReprojection';
import { renderTimings } from '../renderTimings';
import { CloudLightVolume } from './CloudLightVolume';
import { CloudColumnAtlas } from './CloudColumnAtlas';
import { createCloudLightVolumeLayout, type CloudLightBuildInputs, type CloudLightQuality } from './cloudLightVolumeLayout';
import { CloudTemporalState, type CloudTemporalFrame } from './CloudTemporalState';
import { CLOUD_STATIONARY_DEPTH_UNCERTAINTY_M, CLOUD_VIEW_SAMPLING } from './cloudViewSampling';
import { createWeatherBindingUniforms, createWeatherSnapshot } from './cloudWeather';
import { createWeatherMotionState, IDENTITY_WEATHER_MOTION, type WeatherMotionState } from './cloudMotion';
import { CLOUD_WEATHER_GPU_BYTES, loadCloudWeatherAssets } from './cloudWeatherAssets';
import { createCloudPresentationUniforms } from './cloudPresentation';
import { ForkCloudsEffect, createCloudShaderHooks } from './takramCloudBackend';
import mediaGLSL from './shaders/cloudDensity.glsl?raw';
import transportGLSL from './shaders/cloudTransport.glsl?raw';
import lookupGLSL from './shaders/cloudLightLookup.glsl?raw';
import lightingGLSL from './shaders/cloudLighting.glsl?raw';
import presentationGLSL from './shaders/cloudPresentation.glsl?raw';
import distantGLSL from './shaders/distantCloud.glsl?raw';
import columnGLSL from './shaders/cloudColumn.glsl?raw';

const CLOUD_LIGHT_REFRESH_INTERVAL_S = 2;

/** One main-view owner. Weather and light bindings also feed aerial surface lighting. */
export class VolumetricCloudSystem {
  readonly effect: ForkCloudsEffect;
  readonly weather;
  readonly weatherUniforms;
  /** Identity-advection snapshot used only while baking the orbital atlas. */
  readonly canonicalWeatherUniforms;
  readonly lightVolume: CloudLightVolume;
  readonly columnAtlas: CloudColumnAtlas;
  readonly lightingUniforms;
  readonly status = { backend: 'volumetric', state: 'loading', error: '', assetBytes: 0,
    viewBytes: 0, historyReset: [] as readonly string[], light: {} as CloudLightVolume['status'],
    columns: {} as CloudColumnAtlas['status'], referenceWeather: false,
    representation: 'volume', farWeight: 0, lightRefreshCadenceSeconds: CLOUD_LIGHT_REFRESH_INTERVAL_S,
    motion: { enabled: false, timeSeconds: 0, angleRad: 0, atlasAngleRad: 0, windSpeedMps: 15 } };
  private assets?: Awaited<ReturnType<typeof loadCloudWeatherAssets>>;
  private readonly abort = new AbortController();
  private readonly temporal = new CloudTemporalState();
  private readonly reprojection = new CloudReprojectionFrame();
  private readonly position = new Vector3();
  private readonly up = new Vector3();
  private readonly orientation = new Quaternion();
  private readonly worldOrientation = new Quaternion();
  private readonly rotation = new Matrix4();
  private readonly drawingSize = new Vector2();
  private previousLightPosition = new Vector3(Infinity, 0, 0);
  private lightGeneration = 0;
  private lightInputs?: CloudLightBuildInputs;
  private readonly sunDirectionECEF = new Vector3();
  private lightRefreshElapsed = CLOUD_LIGHT_REFRESH_INTERVAL_S;
  private weatherMotion: WeatherMotionState = IDENTITY_WEATHER_MOTION;
  private weatherTimeSeconds = 0;
  private frame?: CloudTemporalFrame;
  private disposed = false;
  private columnReadySince = 0;
  private readonly requestedView = new URLSearchParams(location.search).get('cloudView');

  constructor(readonly camera: Camera, readonly quality: CloudLightQuality, sunDirection: Vector3) {
    // The legacy constructor remains frozen until an environment explicitly opts
    // into motion. This preserves the DEV fixture and ordinary SceneRoot.
    this.weather = createWeatherSnapshot({ visualTimeS: 0, generation: 1,
      planetRadiusM: EARTH_RADIUS_M, sunDirectionECEF: sunDirection.toArray() });
    this.sunDirectionECEF.copy(sunDirection).normalize();
    this.weatherUniforms = createWeatherBindingUniforms(this.weather);
    this.canonicalWeatherUniforms = createWeatherBindingUniforms(this.weather);
    const maxViewPixels = quality === 'low' ? 600_000 : 1_500_000;
    this.columnAtlas = new CloudColumnAtlas({ quality,
      reservedCloudBytes: maxViewPixels * 36 + CLOUD_WEATHER_GPU_BYTES });
    this.lightVolume = new CloudLightVolume({ quality, mediaGLSL,
      reservedCloudBytes: maxViewPixels * 36 + CLOUD_WEATHER_GPU_BYTES + this.columnAtlas.bytes });
    this.status.light = this.lightVolume.status;
    this.status.columns = this.columnAtlas.status;
    this.lightingUniforms = { ...this.weatherUniforms, ...this.lightVolume.uniforms,
      ...this.columnAtlas.uniforms,
      ...createCloudPresentationUniforms(new URLSearchParams(location.search).get('horizon') !== 'off'),
      volumetricCloudAltitudeBoundsM: new Uniform(new Vector2(this.weather.bounds.minAltitudeM, this.weather.bounds.maxAltitudeM)) };
    this.effect = new ForkCloudsEffect(camera, { sharedLighting: true,
      shaderHooks: createCloudShaderHooks({ mediaGLSL,
        lightingGLSL: `${transportGLSL}\n${lookupGLSL}\n${lightingGLSL}\n${presentationGLSL}\n${columnGLSL}\n${distantGLSL}`, uniforms: this.lightingUniforms }) });
    const effect = this.effect;
    effect.qualityPreset = quality;
    effect.ellipsoid = new Ellipsoid(EARTH_RADIUS_M, EARTH_RADIUS_M, EARTH_RADIUS_M);
    effect.sunDirection.copy(sunDirection);
    effect.lightShafts = false;
    effect.temporalUpscale = true;
    effect.cloudsPass.resolveMaterial.uniforms.accumulateFreshSamples.value = true;
    effect.resolutionScale = 1;
    effect.cloudsPass.historyEnabled = new URLSearchParams(location.search).get('history') !== 'off';
    if (!effect.cloudsPass.historyEnabled) effect.temporalUpscale = false;
    effect.haze = false;
    effect.groundBounceScale = 0;
    effect.powderScale = 0;
    effect.skipRendering = true;
    const bounds = this.weather.bounds;
    effect.cloudLayers.set([{ altitude: bounds.minAltitudeM,
      height: bounds.maxAltitudeM - bounds.minAltitudeM, shadow: true }]);
    Object.assign(effect.clouds, CLOUD_VIEW_SAMPLING[quality], {
      minExtinction: 1e-7, minTransmittance: 0.005,
      maxIterationCountToSun: 4, minSecondaryStepSize: 1200,
      maxIterationCountToGround: 0 });
    // Budget-limited grazing rays can outgrow the preferred step size. Retain
    // their existing stationary allowance and the strict moving-camera guard.
    effect.cloudsPass.resolveMaterial.uniforms.stationaryDepthAbsoluteThresholdM.value = CLOUD_STATIONARY_DEPTH_UNCERTAINTY_M;
  }

  /** Update live sun bindings without reconstructing weather resources. */
  setSunDirection(sunDirection: Vector3, discontinuity = false): void {
    const length = sunDirection.length();
    if (!(length > 0) || !Number.isFinite(length)) throw new RangeError('Cloud sun direction must be finite and non-zero');
    const normalized = this.sunDirectionECEF.copy(sunDirection).normalize();
    const binding = this.weatherUniforms.volumetricWeatherSunDirectionECEF?.value;
    if (binding instanceof Vector3) binding.copy(normalized);
    const canonicalBinding = this.canonicalWeatherUniforms.volumetricWeatherSunDirectionECEF?.value;
    if (canonicalBinding instanceof Vector3) canonicalBinding.copy(normalized);
    this.effect.sunDirection.copy(normalized);
    if (discontinuity) this.invalidate();
  }

  /**
   * Bind the caller-owned continuous environment time. Continuous motion only
   * updates uniforms; the explicit discontinuity revision is the sole reason
   * to discard view/light history.
   */
  setEnvironmentTime(timeSeconds: number, discontinuity = false): void {
    const motion = createWeatherMotionState(timeSeconds, this.weather.planetRadiusM, true);
    const changed = motion.timeSeconds !== this.weatherTimeSeconds ||
      motion.angleRad !== this.weatherMotion.angleRad || !this.weatherMotion.enabled;
    // Recompute even on paused frames: the previous rendered angle has caught
    // up, so its velocity must return to zero immediately.
    this.effect.cloudsPass.setMediaMotion(motion.angleRad, true);
    if (!changed && !discontinuity) return;
    this.weatherMotion = motion;
    this.weatherTimeSeconds = motion.timeSeconds;
    this.weatherUniforms.volumetricWeatherVisualTimeS.value = motion.timeSeconds;
    this.weatherUniforms.volumetricWeatherMotionTimeS.value = motion.timeSeconds;
    this.weatherUniforms.volumetricWeatherMotionAngleRad.value = motion.angleRad;
    this.weatherUniforms.volumetricWeatherMotionEnabled.value = 1;
    // The atlas is canonical and never follows live time. It still uses the
    // same seeded fronts, with identity coordinates, exactly once per build.
    this.canonicalWeatherUniforms.volumetricWeatherMotionTimeS.value = 0;
    this.canonicalWeatherUniforms.volumetricWeatherMotionAngleRad.value = 0;
    this.canonicalWeatherUniforms.volumetricWeatherMotionEnabled.value = 1;
    Object.assign(this.status.motion, {
      enabled: true, timeSeconds: motion.timeSeconds, angleRad: motion.angleRad,
      atlasAngleRad: 0, windSpeedMps: motion.windSpeedMps
    });
    if (discontinuity) this.invalidate();
  }

  async load(): Promise<void> {
    const assets = await loadCloudWeatherAssets({ signal: this.abort.signal });
    if (this.disposed) { assets.dispose(); return; }
    this.assets = assets;
    for (const [name, texture] of Object.entries(assets.textures)) {
      const uniformName = ({ coverage: 'volumetricWeatherCoverageTexture', typeField: 'volumetricWeatherTypeFieldTexture',
        referenceField: 'volumetricWeatherReferenceFieldTexture', noise: 'volumetricWeatherNoiseTexture' } as Record<string, string>)[name];
      if (uniformName) {
        this.weatherUniforms[uniformName].value = texture;
        this.canonicalWeatherUniforms[uniformName].value = texture;
      }
    }
    // The authored test region must never overwrite global weather in ordinary flight.
    const referenceEnabled = new URLSearchParams(location.search).get('weatherRegion') === 'reference' ? 1 : 0;
    this.weatherUniforms.volumetricWeatherReferenceFieldEnabled.value = referenceEnabled;
    this.canonicalWeatherUniforms.volumetricWeatherReferenceFieldEnabled.value = referenceEnabled;
    this.status.referenceWeather = referenceEnabled === 1;
    this.status.assetBytes = assets.bytes;
    this.status.state = 'ready';
  }

  beforeRender(renderer: WebGLRenderer, worldToECEF: Matrix4, anchor: readonly number[], metersPerUnit: number, frameDeltaSeconds = 0): void {
    const effect = this.effect;
    effect.worldToECEFMatrix.copy(worldToECEF);
    renderer.getDrawingBufferSize(this.drawingSize);
    const pixels = this.drawingSize.x * this.drawingSize.y;
    const maxPixels = this.quality === 'low' ? 600_000 : 1_500_000;
    // History-off is the native sampling reference at the same output size.
    // Quality caps still apply, but disabling history must not halve the view.
    effect.resolutionScale = Math.min(1, Math.sqrt(maxPixels / Math.max(1, pixels)));
    const width = Math.floor(this.drawingSize.x * effect.resolutionScale);
    const height = Math.floor(this.drawingSize.y * effect.resolutionScale);
    this.status.viewBytes = 24 * width * height + 16 *
      (effect.temporalUpscale ? Math.ceil(width / 4) * Math.ceil(height / 4) : width * height);
    this.camera.getWorldPosition(this.position).applyMatrix4(worldToECEF);
    const altitudeM = this.position.length() - this.weather.planetRadiusM;
    if (this.assets) {
      this.columnAtlas.request(this.weather.generation, this.canonicalWeatherUniforms);
      const started = renderTimings.start('cloud.columnAtlasCpuWall');
      const gpu = renderTimings.beginGpu('cloud.columnAtlas');
      try { this.columnAtlas.update(renderer); }
      finally { renderTimings.endGpu(gpu); renderTimings.end('cloud.columnAtlasCpuWall', started); }
    }
    const ready = this.columnAtlas.uniforms.volumetricColumnReady.value > 0.5;
    if (!ready) this.columnReadySince = 0;
    else if (this.columnReadySince === 0) this.columnReadySince = performance.now();
    const readyBlend = ready ? Math.min(1, (performance.now() - this.columnReadySince) / 750) : 0;
    let transition = Math.max(0, Math.min(1, (altitudeM - 50_000) / 70_000));
    if (this.requestedView === 'volume') transition = 0;
    else if (this.requestedView === 'scaled' && altitudeM > this.weather.bounds.maxAltitudeM) transition = 1;
    const farWeight = transition * transition * (3 - 2 * transition) * readyBlend;
    effect.clouds.farRepresentationMix = farWeight;
    this.status.farWeight = farWeight;
    this.status.representation = farWeight >= 1 ? 'scaled' : farWeight > 0 ? 'transition' : 'volume';
    effect.clouds.farIterationCount = this.quality === 'low' ? 24 : 32;
    this.up.set(0, 1, 0).transformDirection(this.camera.matrixWorld).transformDirection(worldToECEF);
    this.lightRefreshElapsed += Math.max(0, Math.min(frameDeltaSeconds, 0.1));
    // The cadence uses active real time, so it stops on pause. After a fast
    // preview the last snapshot may already be too old: request the stopped
    // weather time once so settling frames can finish a valid light volume.
    const pausedWeatherNeedsRefresh = this.weatherMotion.enabled && frameDeltaSeconds === 0
      && this.lightInputs?.visualTimeSeconds !== this.weatherTimeSeconds;
    if (!this.lightInputs || this.position.distanceTo(this.previousLightPosition) > 20_000
      || this.lightRefreshElapsed >= CLOUD_LIGHT_REFRESH_INTERVAL_S || pausedWeatherNeedsRefresh) {
      const layout = createCloudLightVolumeLayout({ quality: this.quality,
        planetRadiusM: this.weather.planetRadiusM, cameraPositionECEFM: this.position.toArray(),
        // Surface receivers need the same cached sky visibility as cloud samples.
        cameraUpECEF: this.up.toArray(), minAltitudeM: 0,
        maxAltitudeM: this.weather.bounds.maxAltitudeM });
      this.lightInputs = { generation: ++this.lightGeneration, weatherGeneration: this.weather.generation,
        visualTimeSeconds: this.weatherTimeSeconds,
        sunDirectionECEF: [this.sunDirectionECEF.x, this.sunDirectionECEF.y, this.sunDirectionECEF.z], layout };
      this.lightVolume.request(this.lightInputs, this.weatherUniforms);
      this.previousLightPosition.copy(this.position);
      this.lightRefreshElapsed = 0;
    }
    const lightStartedAt = renderTimings.start('cloud.lightVolumeCpuWall');
    const lightGpu = renderTimings.beginGpu('cloud.lightVolume');
    const currentLightInputs: CloudLightBuildInputs = {
      ...this.lightInputs,
      visualTimeSeconds: this.weatherTimeSeconds,
      sunDirectionECEF: [this.sunDirectionECEF.x, this.sunDirectionECEF.y, this.sunDirectionECEF.z],
    };
    try { this.lightVolume.update(renderer, currentLightInputs); }
    finally {
      renderTimings.endGpu(lightGpu);
      renderTimings.end('cloud.lightVolumeCpuWall', lightStartedAt);
    }
    this.rotation.extractRotation(worldToECEF);
    this.worldOrientation.setFromRotationMatrix(this.rotation);
    this.camera.getWorldQuaternion(this.orientation).premultiply(this.worldOrientation);
    const q = this.orientation;
    this.frame = { projectionMatrix: this.camera.projectionMatrix.elements,
      viewportWidth: this.drawingSize.x, viewportHeight: this.drawingSize.y, dpr: renderer.getPixelRatio(),
      backend: 'volumetric', cameraPositionECEFM: this.position.toArray(), cameraOrientationECEF: [q.w, q.x, q.y, q.z],
      rebaseOriginECEFM: [worldToECEF.elements[12], worldToECEF.elements[13], worldToECEF.elements[14]], weatherGeneration: this.weather.generation,
      lightingGeneration: Math.max(0, this.lightVolume.status.generation),
      weatherCompatibilityKey: 1, lightingCompatibilityKey: 1, representationCompatibilityKey: 1,
      nearFarWeights: [1 - farWeight, farWeight] };
    const decision = this.temporal.beforeRender(this.frame);
    this.status.historyReset = decision.reasons;
    if (decision.reset) effect.cloudsPass.invalidateHistory();
    this.reprojection.beforeRender(effect, anchor, metersPerUnit);
  }

  afterRender(anchor: readonly number[]): void {
    if (this.frame) this.temporal.afterRender(this.frame);
    this.reprojection.afterRender(this.camera, anchor);
  }

  invalidate(): void {
    this.temporal.invalidateHistory();
    this.effect.cloudsPass.invalidateHistory();
    this.lightVolume.invalidate();
    this.lightInputs = undefined;
    this.lightRefreshElapsed = CLOUD_LIGHT_REFRESH_INTERVAL_S;
  }

  /** GPU render-target contents do not survive a lost/restored context. */
  invalidateGraphicsContext(): void {
    this.invalidate();
    this.columnAtlas.handleContextLoss();
    this.columnReadySince = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.assets?.dispose();
    this.lightVolume.dispose();
    this.columnAtlas.dispose();
    // The composer owns/disposes effect and its view buffers.
  }
}

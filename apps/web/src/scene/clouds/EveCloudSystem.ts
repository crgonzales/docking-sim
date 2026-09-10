import { Ellipsoid } from '@takram/three-geospatial';
import { Camera, Matrix4, Quaternion, Uniform, Vector2, Vector3, type WebGLRenderer } from 'three';
import { EARTH_RADIUS_M } from '../sky/skyConfig';
import { CloudReprojectionFrame } from '../libraryCloudReprojection';
import { renderTimings } from '../renderTimings';
import { CloudLightVolume } from './CloudLightVolume';
import { CloudColumnAtlas } from './CloudColumnAtlas';
import { createCloudLightVolumeLayout, type CloudLightBuildInputs, type CloudLightQuality } from './cloudLightVolumeLayout';
import { CloudTemporalState, type CloudTemporalFrame } from './CloudTemporalState';
import { createWeatherBindingUniforms, createWeatherSnapshot } from './cloudWeather';
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

/** One main-view owner. Weather and light bindings also feed aerial surface lighting. */
export class EveCloudSystem {
  readonly effect: ForkCloudsEffect;
  readonly weather;
  readonly weatherUniforms;
  readonly lightVolume: CloudLightVolume;
  readonly columnAtlas: CloudColumnAtlas;
  readonly lightingUniforms;
  readonly status = { backend: 'eve', state: 'loading', error: '', assetBytes: 0,
    viewBytes: 0, historyReset: [] as readonly string[], light: {} as CloudLightVolume['status'],
    columns: {} as CloudColumnAtlas['status'], referenceWeather: false,
    representation: 'volume', farWeight: 0 };
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
  private frame?: CloudTemporalFrame;
  private disposed = false;
  private columnReadySince = 0;
  private readonly requestedView = new URLSearchParams(location.search).get('cloudView');

  constructor(readonly camera: Camera, readonly quality: CloudLightQuality, sunDirection: Vector3) {
    // Assets are static in this milestone. A frozen visual time is intentional:
    // don't age a valid lighting generation while its density field is unchanged.
    this.weather = createWeatherSnapshot({ visualTimeS: 0, generation: 1,
      planetRadiusM: EARTH_RADIUS_M, sunDirectionECEF: sunDirection.toArray() });
    this.weatherUniforms = createWeatherBindingUniforms(this.weather);
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
      eveCloudAltitudeBoundsM: new Uniform(new Vector2(this.weather.bounds.minAltitudeM, this.weather.bounds.maxAltitudeM)) };
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
    Object.assign(effect.clouds, { maxIterationCount: quality === 'low' ? 128 : 192,
      minStepSize: 80, maxStepSize: 800, perspectiveStepScale: 1.04,
      minExtinction: 1e-7, minTransmittance: 0.005,
      maxIterationCountToSun: 4, minSecondaryStepSize: 1200,
      maxIterationCountToGround: 0 });
    // A stationary stochastic ray can move its representative depth by one
    // authored step. Moving cameras retain the resolve's strict depth guard.
    effect.cloudsPass.resolveMaterial.uniforms.stationaryDepthAbsoluteThresholdM.value = effect.clouds.maxStepSize;
  }

  async load(): Promise<void> {
    const assets = await loadCloudWeatherAssets({ signal: this.abort.signal });
    if (this.disposed) { assets.dispose(); return; }
    this.assets = assets;
    for (const [name, texture] of Object.entries(assets.textures)) {
      const uniformName = ({ coverage: 'eveWeatherCoverageTexture', typeField: 'eveWeatherTypeFieldTexture',
        referenceField: 'eveWeatherReferenceFieldTexture', noise: 'eveWeatherNoiseTexture' } as Record<string, string>)[name];
      if (uniformName) this.weatherUniforms[uniformName].value = texture;
    }
    // The authored test region must never overwrite global weather in ordinary flight.
    this.weatherUniforms.eveWeatherReferenceFieldEnabled.value =
      new URLSearchParams(location.search).get('weatherRegion') === 'reference' ? 1 : 0;
    this.status.referenceWeather = this.weatherUniforms.eveWeatherReferenceFieldEnabled.value === 1;
    this.status.assetBytes = assets.bytes;
    this.status.state = 'ready';
  }

  beforeRender(renderer: WebGLRenderer, worldToECEF: Matrix4, anchor: readonly number[], metersPerUnit: number): void {
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
    this.status.viewBytes = 20 * width * height + 16 *
      (effect.temporalUpscale ? Math.ceil(width / 4) * Math.ceil(height / 4) : width * height);
    this.camera.getWorldPosition(this.position).applyMatrix4(worldToECEF);
    const altitudeM = this.position.length() - this.weather.planetRadiusM;
    if (this.assets) {
      this.columnAtlas.request(this.weather.generation, this.weatherUniforms);
      const started = renderTimings.start('cloud.columnAtlasCpuWall');
      const gpu = renderTimings.beginGpu('cloud.columnAtlas');
      try { this.columnAtlas.update(renderer); }
      finally { renderTimings.endGpu(gpu); renderTimings.end('cloud.columnAtlasCpuWall', started); }
    }
    const ready = this.columnAtlas.uniforms.eveColumnReady.value > 0.5;
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
    if (!this.lightInputs || this.position.distanceTo(this.previousLightPosition) > 20_000) {
      const layout = createCloudLightVolumeLayout({ quality: this.quality,
        planetRadiusM: this.weather.planetRadiusM, cameraPositionECEFM: this.position.toArray(),
        // Surface receivers need the same cached sky visibility as cloud samples.
        cameraUpECEF: this.up.toArray(), minAltitudeM: 0,
        maxAltitudeM: this.weather.bounds.maxAltitudeM });
      this.lightInputs = { generation: ++this.lightGeneration, weatherGeneration: this.weather.generation,
        visualTimeSeconds: this.weather.visualTimeS, sunDirectionECEF: this.weather.sunDirectionECEF, layout };
      this.lightVolume.request(this.lightInputs, this.weatherUniforms);
      this.previousLightPosition.copy(this.position);
    }
    const lightStartedAt = renderTimings.start('cloud.lightVolumeCpuWall');
    const lightGpu = renderTimings.beginGpu('cloud.lightVolume');
    try { this.lightVolume.update(renderer, this.lightInputs); }
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
      backend: 'eve', cameraPositionECEFM: this.position.toArray(), cameraOrientationECEF: [q.w, q.x, q.y, q.z],
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

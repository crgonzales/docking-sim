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
import { PROBE_CLOUDS, PROBE_EXPOSURE, PROBE_QUALITY, PROBE_WEATHER, PROBE_WEATHER_STRUCTURE } from './renderProbeConfig';

export const libraryStatus = { state: 'loading', error: '', shadowRange: null as CloudShadowRange | null, shadowTexelM: [] as number[], lightingSelection: [0, 0, 0] };
const ROOT = '/vendor/takram';
export function LibraryEffects({ worldFrame, exposureRef }: { worldFrame: WorldFrame; exposureRef: { current: number } }) {
  const { gl, scene, camera, size } = useThree();
  const latestSize = useRef(size);
  const cloudFrame = useRef(new CloudReprojectionFrame());
  const cameraECEF = useRef(new Vector3());
  latestSize.current = size;
  const live = useRef<{ composer: EffectComposer; aerial: ShadowDiagnosticAerialEffect; clouds?: CloudsEffect; mask: LightingMaskPass; originalShadow?: { maxFar: number | null; splitLambda: number } }>();
  useEffect(() => {
    let disposed = false;
    cloudFrame.current = new CloudReprojectionFrame();
    libraryStatus.state = 'loading'; libraryStatus.error = '';
    const owned = new Set<Texture>();
    const own = <T extends Texture>(texture: T): T => {
      if (disposed) texture.dispose(); else owned.add(texture);
      return texture;
    };
    const composer = new EffectComposer(gl, { frameBufferType: HalfFloatType, multisampling: 0 });
    composer.addPass(new RenderPass(scene, camera));
    const normals = new SurfaceNormalPass(scene, camera);
    composer.addPass(normals);
    const mask = new StableLightingMaskPass(scene, camera);
    composer.addPass(mask);
    const ellipsoid = new Ellipsoid(EARTH_RADIUS_M, EARTH_RADIUS_M, EARTH_RADIUS_M);
    const stage = new URLSearchParams(window.location.search).get('stage') ?? 'full';
    const aerial = new ShadowDiagnosticAerialEffect(camera, {
      ellipsoid, correctAltitude: true, correctGeometricError: true,
      transmittance: stage === 'full', inscatter: stage === 'full',
      normalBuffer: normals.texture, reconstructNormal: false, sunLight: true, skyLight: true, sky: true, moon: false,
    });
    aerial.normalBuffer = normals.texture; // The pinned constructor does not set HAS_NORMALS.
    aerial.sunDirection.copy(directionToECEF(SUN_DIR));
    aerial.lightingMask = { map: mask.texture, channel: 'r' };
    const clouds = PROBE_CLOUDS ? new CloudsEffect(camera) : undefined;
    if (clouds) {
      clouds.qualityPreset = PROBE_QUALITY;
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
      composer.addPass(new EffectPass(camera, clouds));
    }
    composer.addPass(new EffectPass(camera, ...(stage === 'albedo' ? [] : [aerial]),
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));
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
    Promise.all([textures, stbn, ...(clouds ? [PROBE_WEATHER === 'global' ? new TextureLoader().loadAsync('/vendor/earth-weather/global-coverage.png').then(own).then(texture => disposed ? texture : configureGlobalWeatherTexture(texture, { mode: PROBE_WEATHER_STRUCTURE })).then(own) : noise2D('local_weather'), noise2D('turbulence'), noise3D('shape', 128), noise3D('shape_detail', 32)] : [])])
      .then(([lut, blueNoise, weather, turbulence, shape, detail]) => {
        // Tuple spread's heterogeneous inference is narrowed at this isolated loader boundary.
        const luts = lut as Awaited<typeof textures>;
        if (disposed) return;
        Object.assign(aerial, luts); aerial.stbnTexture = blueNoise as Data3DTexture;
        if (clouds) {
          Object.assign(clouds, luts);
          clouds.stbnTexture = blueNoise as Data3DTexture;
          clouds.localWeatherTexture = weather as Awaited<ReturnType<typeof noise2D>>;
          clouds.turbulenceTexture = turbulence as Awaited<ReturnType<typeof noise2D>>;
          clouds.shapeTexture = shape as Data3DTexture; clouds.shapeDetailTexture = detail as Data3DTexture;
        }
        composer.setSize(latestSize.current.width, latestSize.current.height);
        live.current = { composer, aerial, clouds, mask, originalShadow: clouds ? { maxFar: clouds.shadow.maxFar, splitLambda: clouds.shadow.splitLambda } : undefined };
        libraryStatus.state = 'ready';
      }).catch(error => { if (!disposed) { libraryStatus.state = 'failed'; libraryStatus.error = String(error); console.error(error); } });
    return () => { disposed = true; live.current = undefined; composer.dispose(); owned.forEach(texture => texture.dispose()); owned.clear(); };
  }, [gl, scene, camera, worldFrame]);
  useEffect(() => { live.current?.composer.setSize(size.width, size.height); }, [size]);
  useFrame((_, delta) => {
    exposureRef.current = PROBE_EXPOSURE;
    gl.toneMappingExposure = PROBE_EXPOSURE;
    const value = live.current;
    if (!value) { gl.render(scene, camera); return; }
    value.aerial.shadowStrength.value = cloudShadowProbe.mode === 'off' ? 0 : 1;
    value.aerial.shadowDiagnostic.value = ({ mask: 1, lighting: 2, normals: 3 } as Record<string, number>)[cloudShadowProbe.mode] ?? 0;
    value.aerial.cloudOverlay.value = cloudShadowProbe.overlay ? 1 : 0;
    value.aerial.waterLighting.value = cloudShadowProbe.waterReflections ? 1 : 0;
    updateWorldToECEF(worldFrame, value.aerial.worldToECEFMatrix);
    if (value.clouds) value.clouds.worldToECEFMatrix.copy(value.aerial.worldToECEFMatrix);
    if (value.clouds && camera instanceof PerspectiveCamera && cloudShadowProbe.range === 'fitted') {
      camera.getWorldPosition(cameraECEF.current).applyMatrix4(value.clouds.worldToECEFMatrix);
      libraryStatus.shadowRange = configureCloudShadowRange(value.clouds, camera, {
        cameraAltitudeM: cameraECEF.current.length() - EARTH_RADIUS_M,
      });
    } else if (value.clouds && value.originalShadow) {
      Object.assign(value.clouds.shadow, value.originalShadow);
      libraryStatus.shadowRange = null;
    }
    if (value.clouds) cloudFrame.current.beforeRender(value.clouds, worldFrame.anchor, SKY_CONFIG.renderScaleMPerUnit);
    value.mask.selection.clear();
    let lit = 0, excluded = 0;
    scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.every(material => !(material instanceof ShaderMaterial) || !material.defines.LIBRARY_LIGHTING)) { value.mask.selection.add(object); excluded++; }
      else lit++;
    });
    libraryStatus.lightingSelection = [lit, excluded, value.mask.selectionLayer];
    value.composer.render(delta);
    if (value.clouds) libraryStatus.shadowTexelM = value.clouds.shadowMaps.cascades.map(cascade =>
      2 / cascade.projectionMatrix.elements[0] / value.clouds!.shadow.mapSize.x * SKY_CONFIG.renderScaleMPerUnit);
    cloudFrame.current.afterRender(camera, worldFrame.anchor);
  }, 1);
  return null;
}

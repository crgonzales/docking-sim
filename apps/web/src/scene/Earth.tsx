import { EARTH_KTX_UV_GLSL } from './libraryEarthTextureOrientation';
import { useCallback, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import {
  Group,
  Mesh,
  NoColorSpace,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import {
  EARTH_CENTER_DISTANCE_M,
  EARTH_RADIUS_M,
  metersToSceneUnits,
  terrainFadeFromAltitudeM,
} from './sky/skyConfig';
import { TerrainPatches } from './terrain/TerrainPatches';
import type { TerrainTileSource } from './terrain/tileSource';
import { WorldFrame, type WorldPositionF64 } from './worldFrame';

/**
 * Earth surface for the library atmosphere pipeline. The opaque globe emits
 * linear imagery albedo plus water metadata; the composer's aerial-perspective
 * and volumetric weather passes light it and draw the atmosphere. Real terrain
 * patches replace the globe once the camera enters the crossfade band and the
 * patch cover is complete.
 *
 * Scale handling: the render scene is the Hill frame in meters, but Earth at
 * its true distance (~6.771e6 m) is kept stable by the shared floating origin.
 * The group position is re-derived from the absolute Earth centre on every
 * frame, so rebasing never touches vertex data.
 */
const EARTH_CENTER_WORLD: WorldPositionF64 = [-EARTH_CENTER_DISTANCE_M, 0, 0];

/**
 * R3F memoizes loaders by constructor for the lifetime of the page. Keeping
 * KTX2Loader behind useLoader therefore gives the transcoder one shared,
 * page-lifetime instance. It is intentionally never disposed here: ANALYSIS
 * unmounts Canvas and SANDBOX can mount it again later.
 */
const KTX2_TRANSCODER_PATH = '/';

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  // Preserve geometric clipping; use the same fragment depth as built-in materials.
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const earthFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D dayMap;
  uniform sampler2D specMap;
  varying vec2 vUv;

  const float PI = 3.14159265359;

${EARTH_KTX_UV_GLSL}

  void main() {
    #include <logdepthbuf_fragment>
    // Opaque material metadata; aerial lighting restores alpha after decoding.
    // Color and water classification must share the packaged KTX orientation.
    vec2 mapUv = earthMapUv(vUv);
    float water = earthWaterFraction(texture2D(specMap, mapUv).r);
    gl_FragColor = vec4(earthSurfaceAlbedo(texture2D(dayMap, mapUv).rgb), 1.0 - 0.5 * water);
  }
`;

function supportsCompressedEarthTier(renderer: WebGLRenderer) {
  const { capabilities, extensions } = renderer;
  return capabilities.isWebGL2
    && capabilities.maxTextureSize >= 8192
    && (
      extensions.has('EXT_texture_compression_bptc')
      || extensions.has('WEBGL_compressed_texture_s3tc')
      || extensions.has('WEBGL_compressed_texture_astc')
      || extensions.has('WEBGL_compressed_texture_etc')
    );
}

function getEarthDayMapUrl(renderer: WebGLRenderer) {
  return supportsCompressedEarthTier(renderer)
    ? '/assets/textures/earth_day_4k.ktx2'
    : '/assets/textures/earth_day_2k.ktx2';
}

export interface EarthProps {
  worldFrame: WorldFrame;
  terrainSourceRef: { current: TerrainTileSource | null };
}

export function Earth({ worldFrame, terrainSourceRef }: EarthProps) {
  const { gl: renderer, camera } = useThree();
  const dayMapUrl = useMemo(() => getEarthDayMapUrl(renderer), [renderer]);
  const configureKtx2Loader = useCallback((loader: KTX2Loader) => {
    // useLoader memoizes KTX2Loader by constructor, making this one
    // page-lifetime loader. detectSupport runs before the first request.
    loader.setTranscoderPath(KTX2_TRANSCODER_PATH);
    loader.detectSupport(renderer);
  }, [renderer]);
  const [dayMap, specMap] = useLoader(
    KTX2Loader,
    [dayMapUrl, '/assets/textures/earth_spec_2k.ktx2'],
    configureKtx2Loader,
  );

  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  dayMap.colorSpace = SRGBColorSpace;
  specMap.colorSpace = NoColorSpace;
  dayMap.anisotropy = anisotropy;
  specMap.anisotropy = anisotropy;

  const radius = metersToSceneUnits(EARTH_RADIUS_M);
  const earthGroupRef = useRef<Group>(null);
  const globeRef = useRef<Mesh>(null);
  const terrainCoverageReady = useRef(false);
  const onCoverageReadyChange = useCallback((ready: boolean) => { terrainCoverageReady.current = ready; }, []);
  const initialPosition = useMemo(
    () => new Vector3(...worldFrame.toRender(EARTH_CENTER_WORLD)),
    [worldFrame],
  );

  const earthMaterial = useMemo(
    () =>
      new ShaderMaterial({
        // The define marks this surface for the composer's aerial lighting mask.
        defines: { LIBRARY_LIGHTING: 1 },
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
        uniforms: {
          dayMap: { value: dayMap },
          specMap: { value: specMap },
        },
      }),
    [dayMap, specMap],
  );

  useFrame(() => {
    const renderCenter = worldFrame.toRender(EARTH_CENTER_WORLD);
    const cameraWorld = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    const cameraAltitudeM = Math.hypot(
      cameraWorld[0] - EARTH_CENTER_WORLD[0],
      cameraWorld[1] - EARTH_CENTER_WORLD[1],
      cameraWorld[2] - EARTH_CENTER_WORLD[2],
    ) - EARTH_RADIUS_M;
    earthGroupRef.current?.position.set(renderCenter[0], renderCenter[1], renderCenter[2]);
    // The globe is the ground until the terrain patches cover the view; it
    // retires only inside the crossfade band once that cover is complete, so
    // real DEM elevation below the mean radius never fights it for depth.
    if (globeRef.current) {
      globeRef.current.visible = terrainFadeFromAltitudeM(cameraAltitudeM) <= 0 || !terrainCoverageReady.current;
    }
  });

  return (
    <>
      <group ref={earthGroupRef} position={initialPosition}>
        <mesh ref={globeRef} material={earthMaterial} renderOrder={0}>
          <sphereGeometry args={[radius, 192, 192]} />
        </mesh>
      </group>
      <TerrainPatches
        onCoverageReadyChange={onCoverageReadyChange}
        worldFrame={worldFrame}
        terrainSourceRef={terrainSourceRef}
        earthCenterF64={EARTH_CENTER_WORLD}
        dayMap={dayMap}
        specMap={specMap}
        radius={radius}
      />
    </>
  );
}

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Color, DirectionalLight, NoToneMapping } from 'three';
import { LibraryEffects } from './LibraryEffects';
import { RenderProbe } from './RenderProbe';
import { LIBRARY_RENDERER, PROBE_DPR, RENDER_PROBE } from './renderProbeConfig';
import { Earth } from './Earth';
import { Effects } from './Effects';
import { CameraRig } from './CameraRig';
import { DockingCameraPass } from './DockingCameraPiP';
import { Spacecraft } from './Spacecraft';
import { Starfield } from './Starfield';
import { SunSprite } from './SunSprite';
import { SUN_DIR, SUN_LIGHT_DISTANCE_M } from './sun';
import {
  ATMOSPHERE_TRANSMITTANCE_LUT_PATH,
  CAMERA_FAR,
  CAMERA_NEAR,
  EARTH_RADIUS_M,
  SKY_CONFIG,
  SKY_DERIVED,
} from './sky/skyConfig';
import {
  sampleTransmittanceLut,
  TRANSMITTANCE_LUT_SIZE,
} from './sky/atmosphereMath';
import { WorldFrame, type WorldPositionF64 } from './worldFrame';
import { parseFlytoParam } from './flytoParam';
import { useViewStore } from '../viewStore';
import type { TerrainTileSource } from './terrain/tileSource';
import { frameExposureFromCamera } from './sky/exposure';

const EARTH_CENTER_WORLD: WorldPositionF64 = [-SKY_DERIVED.earthCenterDistanceM, 0, 0];

interface FrameExposureControllerProps {
  readonly worldFrame: WorldFrame;
  readonly exposureRef: { current: number };
}

function FrameExposureController({ worldFrame, exposureRef }: FrameExposureControllerProps) {
  const { camera } = useThree();

  useFrame(() => {
    const cameraWorld = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    const cameraDelta = [
      cameraWorld[0] - EARTH_CENTER_WORLD[0],
      cameraWorld[1] - EARTH_CENTER_WORLD[1],
      cameraWorld[2] - EARTH_CENTER_WORLD[2],
    ];
    const cameraAltitudeKm = (Math.hypot(cameraDelta[0], cameraDelta[1], cameraDelta[2]) - EARTH_RADIUS_M) / 1000;
    exposureRef.current = frameExposureFromCamera({
      cameraPositionWorld: {
        x: cameraWorld[0],
        y: cameraWorld[1],
        z: cameraWorld[2],
      },
      planetCenterWorld: {
        x: EARTH_CENTER_WORLD[0],
        y: EARTH_CENTER_WORLD[1],
        z: EARTH_CENTER_WORLD[2],
      },
      cameraAltitudeKm,
    }).exposure;
  });

  return null;
}

interface WorldFrameControllerProps {
  worldFrame: WorldFrame;
}

function WorldFrameController({ worldFrame }: WorldFrameControllerProps) {
  const { camera } = useThree();
  const heartbeatRef = useRef({ frames: 0, lastLog: 0 });

  useFrame(() => {
    heartbeatRef.current.frames += 1;
    const nowMs = performance.now();
    if (new URLSearchParams(window.location.search).get('terraindiag') === '1'
      && nowMs - heartbeatRef.current.lastLog >= 2000) {
      heartbeatRef.current.lastLog = nowMs;
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      // eslint-disable-next-line no-console
      console.log('[frame-diag]', JSON.stringify({
        t: Math.round(nowMs), frames: heartbeatRef.current.frames,
        heapMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : -1,
        tiles: (globalThis as { __tileDiag?: object }).__tileDiag ?? null,
      }));
    }
    const cameraWorld = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    if (!worldFrame.rebase(cameraWorld)) return;
    // Keep the camera at the same physical position while every world object
    // is re-derived from the new render anchor on this frame.
    const cameraRender = worldFrame.toRender(cameraWorld);
    camera.position.set(cameraRender[0], cameraRender[1], cameraRender[2]);
  }, -1);

  return null;
}

interface SunLightProps {
  sunTint: Color;
  worldFrame: WorldFrame;
}

function SunLight({ sunTint, worldFrame }: SunLightProps) {
  const lightRef = useRef<DirectionalLight>(null);
  const sunWorld: WorldPositionF64 = [
    SUN_DIR.x * SUN_LIGHT_DISTANCE_M,
    SUN_DIR.y * SUN_LIGHT_DISTANCE_M,
    SUN_DIR.z * SUN_LIGHT_DISTANCE_M,
  ];

  useFrame(() => {
    if (lightRef.current === null) return;
    const position = worldFrame.toRender(sunWorld);
    lightRef.current.position.set(position[0], position[1], position[2]);
  });

  const initialPosition = worldFrame.toRender(sunWorld);
  return (
    <directionalLight
      ref={lightRef}
      position={initialPosition}
      intensity={2.4}
      color={sunTint}
    />
  );
}

function useSunExtinctionTint(): Color {
  const [sunTint, setSunTint] = useState(() => new Color(1, 1, 1));

  useEffect(() => {
    let mounted = true;
    fetch(ATMOSPHERE_TRANSMITTANCE_LUT_PATH)
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load ${ATMOSPHERE_TRANSMITTANCE_LUT_PATH}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        const data = new Float32Array(buffer);
        // The fixed SUN_DIR is evaluated at the representative subsolar point
        // and the operating cloud-deck altitude. Normalize red to preserve
        // light intensity while retaining the LUT's atmospheric warmth.
        const transmittance = sampleTransmittanceLut(
          data,
          TRANSMITTANCE_LUT_SIZE,
          SKY_CONFIG.deckAltitudeKm,
          SUN_DIR.dot(SUN_DIR),
          SKY_CONFIG.atmosphere,
        );
        const scale = Math.max(transmittance[0], Number.EPSILON);
        if (mounted) setSunTint(new Color(
          transmittance[0] / scale,
          transmittance[1] / scale,
          transmittance[2] / scale,
        ));
      })
      .catch(() => {
        // White is the neutral fallback until the committed table is available.
      });
    return () => {
      mounted = false;
    };
  }, []);

  return sunTint;
}

/**
 * Scene composition. Scene units = meters in the Hill frame (origin at the
 * target COM). The camera frames the chaser's approach axis with the target
 * ahead and the Earth limb (−x̂, see Earth.tsx scaled group) in shot.
 * Logarithmic depth buffer + Earth view-scaling keep meter-scale craft and
 * the planet coexisting without z-fighting.
 */
export function SceneRoot() {
  const sunTint = useSunExtinctionTint();
  const worldFrame = useMemo(() => new WorldFrame(), []);
  const terrainSourceRef = useRef<TerrainTileSource | null>(null);
  const frameExposureRef = useRef(1);

  // Debug deep link: ?flyto=lat,lon,altM spawns the DEBUG FLY camera at a
  // geodetic position facing the local horizon — reproducible framings for
  // captures and bug reports.
  useEffect(() => {
    const spawn = parseFlytoParam(window.location.search);
    if (spawn === null) return;
    const view = useViewStore.getState();
    view.setMode('DEBUG');
    if (useViewStore.getState().debugSubmode !== 'FLY') view.toggleDebugSubmode();
    const query = new URLSearchParams(window.location.search);
    view.setFlyPose(spawn.positionM, Number(query.get('yaw') ?? '90') * Math.PI / 180,
      Number(query.get('pitch') ?? '0') * Math.PI / 180);
  }, []);

  return (
    <Canvas
      // The library's full-screen buffers follow canvas DPR. Keep normal play
      // on the same pixel budget as the measured profile (explicit override
      // remains available), instead of silently tripling work on Retina.
      dpr={RENDER_PROBE || LIBRARY_RENDERER ? PROBE_DPR : [1, 1.75]}
      gl={{ logarithmicDepthBuffer: true, powerPreference: 'high-performance', antialias: true }}
      camera={{ position: [40, -320, 60], fov: 45, near: CAMERA_NEAR, far: CAMERA_FAR }}
      onCreated={({ camera, gl }) => {
        gl.toneMapping = NoToneMapping;
        camera.lookAt(0, -80, 0);
      }}
    >
      <WorldFrameController worldFrame={worldFrame} />
      <Suspense fallback={null}>
        {!LIBRARY_RENDERER && <Starfield />}
        {!LIBRARY_RENDERER && <SunSprite sunTint={sunTint} worldFrame={worldFrame} />}
        <Earth worldFrame={worldFrame} terrainSourceRef={terrainSourceRef} />
      </Suspense>
      <SunLight sunTint={sunTint} worldFrame={worldFrame} />
      {/* faint earthshine so the night side of the craft isn't pure black */}
      <ambientLight intensity={0.06} color="#7d9bff" />
      <Spacecraft worldFrame={worldFrame} />
      <CameraRig worldFrame={worldFrame} terrainSourceRef={terrainSourceRef} />
      <FrameExposureController worldFrame={worldFrame} exposureRef={frameExposureRef} />
      <DockingCameraPass worldFrame={worldFrame} exposureRef={frameExposureRef} />
      {LIBRARY_RENDERER ? <LibraryEffects worldFrame={worldFrame} exposureRef={frameExposureRef} /> : <Effects exposureRef={frameExposureRef} />}
      {RENDER_PROBE && <RenderProbe worldFrame={worldFrame} />}
    </Canvas>
  );
}

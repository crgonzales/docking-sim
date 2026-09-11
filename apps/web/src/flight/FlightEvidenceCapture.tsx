import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DirectionalLight, HemisphereLight, LightProbe, Mesh } from 'three';
import { libraryStatus } from '../scene/LibraryEffects';
import { renderTimings } from '../scene/renderTimings';
import { SUN_DIR } from '../scene/sun';
import type { CharacterSession } from '../character/characterSession';
import type { FlightSession } from './flightSession';
import type { FlightEnvironmentSource } from './flightEnvironment';

interface FlightEvidenceCaptureProps {
  session: FlightSession;
  environment?: FlightEnvironmentSource;
  fixtureName: string;
  character?: CharacterSession;
  request: number;
  quality: 'low' | 'medium';
  onSaved: (message: string) => void;
}

export function FlightEvidenceCapture({ session, environment, fixtureName, character, request, quality, onSaved }: FlightEvidenceCaptureProps) {
  const invalidate = useThree((state) => state.invalidate);
  const pending = useRef(false);
  const frameTiming = useRef({ frames: 0, elapsedMs: 0, previousMs: null as number | null });
  useEffect(() => {
    if (request === 0) return;
    pending.current = true;
    invalidate();
  }, [request, invalidate]);
  useFrame(({ camera, gl, scene }) => {
    // Count consecutive running frames only; paused warmup and pause duration
    // must not contaminate a before/after performance sample.
    const timing = frameTiming.current;
    const now = performance.now();
    if (character?.paused ?? session.paused) timing.previousMs = null;
    else {
      if (timing.previousMs !== null) { timing.frames++; timing.elapsedMs += now - timing.previousMs; }
      timing.previousMs = now;
    }
    if (!pending.current) return;
    pending.current = false;
    const instruments = session.instruments();
    const characterPose = character?.camera;
    const name = `flight-${fixtureName}-${Date.now()}`;
    const localLights: unknown[] = [];
    const ambientLights: unknown[] = [];
    let shadowCasters = 0;
    scene.traverseVisible((object) => {
      if (object instanceof Mesh && object.castShadow) shadowCasters++;
      if (object instanceof LightProbe) ambientLights.push({
        type: 'probe', intensity: object.intensity, coefficients: object.sh.coefficients.map(value => value.toArray()),
      });
      if (object instanceof HemisphereLight) ambientLights.push({
        type: 'hemisphere', intensity: object.intensity, sky: object.color.toArray(), ground: object.groundColor.toArray(),
      });
      if (object instanceof DirectionalLight) localLights.push({
        intensity: object.intensity, color: object.color.toArray(), position: object.position.toArray(),
        target: object.target.position.toArray(), castShadow: object.castShadow,
        mapReady: object.shadow.map !== null, mapSize: object.shadow.mapSize.toArray(),
        coverage: { left: object.shadow.camera.left, right: object.shadow.camera.right,
          top: object.shadow.camera.top, bottom: object.shadow.camera.bottom },
        bias: object.shadow.bias, normalBias: object.shadow.normalBias,
      });
    });
    const context = {
      url: window.location.href, fixture: fixtureName, renderer: 'library', cloudSystem: 'eve',
      quality, dpr: gl.getPixelRatio(), drawingBuffer: [gl.domElement.width, gl.domElement.height], paused: character?.paused ?? session.paused,
      timings: renderTimings.snapshot(),
      runningFrames: { frames: timing.frames, elapsedMs: timing.elapsedMs },
      rendererResources: {
        ...gl.info.memory, programs: gl.info.programs?.length ?? 0,
        maxTextureSize: gl.capabilities.maxTextureSize,
        maxTextureUnits: gl.capabilities.maxTextures,
      },
      localLighting: { shadowsEnabled: gl.shadowMap.enabled, shadowCasters, lights: localLights, ambientLights },
      physicalState: structuredClone(session.state), controls: structuredClone(session.controls),
      environment: structuredClone(session.environment),
      environmentClock: environment
        ? { mode: 'dynamic', state: structuredClone(environment.state) }
        : { mode: 'legacy-static', sunDirection: SUN_DIR.toArray(), weather: 'fixture/default static' },
      camera: { mode: character?.mode === 'ON_FOOT' ? 'ON_FOOT' : session.camera, position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), projectionMatrix: camera.projectionMatrix.elements.slice() },
      character: character ? {
        state: structuredClone(character.state),
        parked: character.parked,
        cameraPose: characterPose ? {
          eyeWorld: [...characterPose.eyeWorld],
          forwardWorld: [...characterPose.forwardWorld],
          upWorld: [...characterPose.upWorld],
        } : null,
      } : undefined,
      stateMetadata: {
        time_s: session.state.time_s, altitude_m: instruments.altitude_m,
        bank_deg: instruments.bank_rad * 180 / Math.PI, pitch_deg: instruments.pitch_rad * 180 / Math.PI,
        airspeed_m_s: instruments.airspeed_m_s, status: session.state.status,
      },
      libraryStatus: {
        state: libraryStatus.state, error: libraryStatus.error,
        shadowRange: structuredClone(libraryStatus.shadowRange), shadowTexelM: [...libraryStatus.shadowTexelM],
        lightingSelection: [...libraryStatus.lightingSelection], eve: structuredClone(libraryStatus.eve),
        graphics: structuredClone(libraryStatus.graphics),
      },
    };
    void fetch('/__render-evidence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, image: gl.domElement.toDataURL('image/png'), samples: [], context }),
    }).then((response) => onSaved(response.ok ? name : 'Capture failed')).catch(() => onSaved('Capture failed'));
  }, 3);
  return null;
}

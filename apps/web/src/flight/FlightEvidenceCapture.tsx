import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { DirectionalLight, Mesh } from 'three';
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
  useEffect(() => {
    if (request === 0) return;
    pending.current = true;
    invalidate();
  }, [request, invalidate]);
  useFrame(({ camera, gl, scene }) => {
    if (!pending.current) return;
    pending.current = false;
    const instruments = session.instruments();
    const characterPose = character?.camera;
    const name = `flight-${fixtureName}-${Date.now()}`;
    const localLights: unknown[] = [];
    let shadowCasters = 0;
    scene.traverseVisible((object) => {
      if (object instanceof Mesh && object.castShadow) shadowCasters++;
      if (object instanceof DirectionalLight) localLights.push({
        intensity: object.intensity, position: object.position.toArray(),
        target: object.target.position.toArray(), castShadow: object.castShadow,
        mapReady: object.shadow.map !== null, mapSize: object.shadow.mapSize.toArray(),
      });
    });
    const context = {
      url: window.location.href, fixture: fixtureName, renderer: 'library', cloudSystem: 'eve',
      quality, dpr: gl.getPixelRatio(), drawingBuffer: [gl.domElement.width, gl.domElement.height], paused: character?.paused ?? session.paused,
      timings: renderTimings.snapshot(),
      localLighting: { shadowsEnabled: gl.shadowMap.enabled, shadowCasters, lights: localLights },
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
      },
    };
    void fetch('/__render-evidence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, image: gl.domElement.toDataURL('image/png'), samples: [], context }),
    }).then((response) => onSaved(response.ok ? name : 'Capture failed')).catch(() => onSaved('Capture failed'));
  }, 3);
  return null;
}

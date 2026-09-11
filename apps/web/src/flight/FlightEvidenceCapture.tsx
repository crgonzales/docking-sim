import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { libraryStatus } from '../scene/LibraryEffects';
import { renderTimings } from '../scene/renderTimings';
import type { FlightSession } from './flightSession';

interface FlightEvidenceCaptureProps {
  session: FlightSession;
  fixtureName: string;
  request: number;
  quality: 'low' | 'medium';
  onSaved: (message: string) => void;
}

export function FlightEvidenceCapture({ session, fixtureName, request, quality, onSaved }: FlightEvidenceCaptureProps) {
  const invalidate = useThree((state) => state.invalidate);
  const pending = useRef(false);
  useEffect(() => {
    if (request === 0) return;
    pending.current = true;
    invalidate();
  }, [request, invalidate]);
  useFrame(({ camera, gl }) => {
    if (!pending.current) return;
    pending.current = false;
    const instruments = session.instruments();
    const name = `flight-${fixtureName}-${Date.now()}`;
    const context = {
      url: window.location.href, fixture: fixtureName, renderer: 'library', cloudSystem: 'eve',
      quality, dpr: gl.getPixelRatio(), drawingBuffer: [gl.domElement.width, gl.domElement.height], paused: session.paused,
      timings: renderTimings.snapshot(),
      physicalState: structuredClone(session.state), controls: structuredClone(session.controls),
      environment: structuredClone(session.environment),
      camera: { mode: session.camera, position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), projectionMatrix: camera.projectionMatrix.elements.slice() },
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

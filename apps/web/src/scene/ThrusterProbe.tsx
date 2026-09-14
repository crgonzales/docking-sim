import { useEffect, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, Mesh, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { CREW_DRAGON_THRUSTERS } from '@docking/sim-core';
import { inspectThruster } from '../telemetry/simEmitter';
import { useTelemetryBus } from '../telemetry/bus';
import { useViewStore } from '../viewStore';
import { renderRcsAudioPreview } from '../hud/rcsAudioPreview';
import { THRUSTER_NOZZLES } from './thrusterPresentation';
import { useRcsInspection } from './rcsInspection';

export function ThrusterProbe() {
  const selected = useRcsInspection(s => s.jet);
  const vectors = useRcsInspection(s => s.vectors);
  const [status, setStatus] = useState('Ready');
  const [telemetry, setTelemetry] = useState('{}');
  const [follow, setFollow] = useState(false);
  const { camera } = useThree();
  const originalUp = useRef(camera.up.clone());
  const nozzlePoint = useRef(new Vector3()), nozzleRotation = useRef(new Quaternion());
  useEffect(() => () => { camera.up.copy(originalUp.current); }, [camera]);
  const anchor = useRef<Group>(null);
  const direction = useRef(new Vector3());
  const capture = useRef(false);
  const last = useRef(0);
  function view(azimuth: number, elevation: number) {
    setFollow(false); camera.up.copy(originalUp.current);
    const store = useViewStore.getState(); store.setMode('CHASE');
    const orbit = useViewStore.getState().orbits.CHASE;
    store.orbitBy(azimuth - orbit.azimuth_rad, elevation - orbit.elevation_rad);
    store.zoomBy(16 / orbit.distance_m);
  }
  useEffect(() => { inspectThruster(null); view(0.85, 0.35); }, []);
  useFrame(({ scene, camera }) => {
    if (!follow) return;
    const mesh = scene.getObjectByName(`rcs-plume-${selected}`);
    if (!mesh?.parent) return;
    const nozzle = THRUSTER_NOZZLES.find(n => n.id === selected)!;
    mesh.getWorldPosition(nozzlePoint.current);
    mesh.parent.getWorldQuaternion(nozzleRotation.current);
    const exhaust = new Vector3(...nozzle.exhaust);
    const radial = new Vector3(nozzle.exit[0], 0, nozzle.exit[2]).normalize();
    radial.addScaledVector(exhaust, -radial.dot(exhaust)).normalize();
    camera.position.copy(nozzlePoint.current).add(radial.multiplyScalar(6).applyQuaternion(nozzleRotation.current));
    camera.up.set(0, 1, 0).applyQuaternion(nozzleRotation.current);
    camera.lookAt(nozzlePoint.current.clone().add(exhaust.multiplyScalar(0.7).applyQuaternion(nozzleRotation.current)));
    camera.updateMatrixWorld();
  }, 0.5);
  useFrame(({ camera, gl, clock, scene }) => {
    camera.getWorldDirection(direction.current);
    anchor.current?.position.copy(camera.position).add(direction.current);
    if (capture.current) {
      capture.current = false;
      const name = `rcs-${selected}-${Date.now()}`;
      void fetch('/__render-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, image: gl.domElement.toDataURL('image/png'),
          context: { selected, vectors, nozzles: THRUSTER_NOZZLES },
          samples: [{ truth: useTelemetryBus.getState().renderState, commanded: useTelemetryBus.getState().frame?.thruster_duty }] })
      }).then(r => setStatus(r.ok ? name : 'Capture failed'));
    }
    if (clock.elapsedTime - last.current < 0.2) return;
    last.current = clock.elapsedTime;
    const truth = useTelemetryBus.getState().renderState;
    const spec = CREW_DRAGON_THRUSTERS.find(jet => jet.id === selected)!;
    const plume = scene.getObjectByName(`rcs-plume-${selected}`) as Mesh | undefined;
    setTelemetry(JSON.stringify({ selected, actualDuty: truth?.thruster_duty[selected] ?? 0,
      commandedDuty: useTelemetryBus.getState().frame?.thruster_duty[selected],
      forceDirectionBody: spec.direction_body, mountBodyM: spec.position_body_m,
      nozzleExitBodyM: THRUSTER_NOZZLES.find(nozzle => nozzle.id === selected)!.exit,
      plume: plume ? { visible: plume.visible, duty: (plume.material as ShaderMaterial).uniforms.duty?.value,
        position: plume.getWorldPosition(new Vector3()).toArray(), camera: camera.position.toArray() } : null,
      allActualDuty: truth?.thruster_duty }));
  }, 3);
  const gameQuery = new URLSearchParams(window.location.search); gameQuery.delete('thrusterProbe');
  return <group ref={anchor}><Html fullscreen calculatePosition={(_object, _camera, size) => [size.width / 2, size.height / 2]}
    style={{ pointerEvents: 'none' }}><aside style={{ position: 'absolute', right: 12, top: 75, width: 280,
      padding: 12, color: '#dae9ff', background: '#07111eee', font: '12px monospace', pointerEvents: 'auto' }}>
    <strong>Thruster inspection</strong>
    <p>Actual simulated firing. Cyan = force, amber = exhaust.</p>
    <div>{THRUSTER_NOZZLES.map(jet => <button key={jet.id} aria-pressed={jet.id === selected}
      onClick={() => { inspectThruster(null); useRcsInspection.getState().select(jet.id); }}>{jet.id}</button>)}</div>
    <div><button onClick={() => inspectThruster(selected)}>Fire selected</button>
      <button onClick={() => inspectThruster(null)}>Stop firing</button></div>
    <button onClick={useRcsInspection.getState().toggleVectors}>Vectors {vectors ? 'on' : 'off'}</button>
    <button onClick={() => setFollow(true)}>View nozzle</button>
    <div><button onClick={() => view(Math.PI, 0.3)}>View front</button>
      <button onClick={() => view(Math.PI / 2, 0.3)}>View side</button>
      <button onClick={() => view(0, 0.3)}>View aft</button></div>
    <button onClick={() => { capture.current = true; }}>Capture thrusters</button>
    <button onClick={async () => {
      setStatus('Rendering sound check');
      const preview = await renderRcsAudioPreview(); const name = `rcs-audio-${Date.now()}`;
      await fetch('/__render-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, audio: preview.dataUrl, samples: [preview.checks], context: { passed: preview.passed } }) });
      setStatus(JSON.stringify({ name, passed: preview.passed, ...preview.checks }));
    }}>Save audio check</button>
    <p><a href={`?${gameQuery}`} style={{ color: '#b9dcff' }}>Return to game</a></p>
    <output data-testid="thruster-inspection" style={{ display: 'block', overflowWrap: 'anywhere' }}>{telemetry}</output>
    <output data-testid="thruster-status" style={{ display: 'block', marginTop: 8, overflowWrap: 'anywhere' }}>{status}</output>
  </aside></Html></group>;
}

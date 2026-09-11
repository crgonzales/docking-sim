import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Matrix4, NoToneMapping, Vector3, type Group, type HemisphereLight } from 'three';
import { conjugateQuaternion, rotateVector, type Vec3 } from '@docking/sim-core';
import { Earth } from '../scene/Earth';
import { WorldFrame } from '../scene/worldFrame';
import { SKY_CONFIG } from '../scene/sky/skyConfig';
import { SUN_DIR, SUN_LIGHT_DISTANCE_M } from '../scene/sun';
import { LibraryEffects, libraryStatus } from '../scene/LibraryEffects';
import { PROBE_DPR, PROBE_EXPOSURE, PROBE_QUALITY } from '../scene/renderProbeConfig';
import type { TerrainTileSource } from '../scene/terrain/tileSource';
import { flightWorldFrame } from './flightFrame';
import { FLIGHT_KEYS, FlightSession } from './flightSession';
import { handleFlightKeyDown } from './flightInput';
import { FlightExercisePanel } from './FlightExercisePanel';
import { HornetModel } from './HornetModel';
import './flight.css';

type Instruments = ReturnType<FlightSession['instruments']>;
const degrees = (rad: number) => rad * 180 / Math.PI;
const FLIGHT_ENVIRONMENT = (() => {
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  return {
    dpr: query.has('dpr') ? PROBE_DPR : 1,
    exposure: query.has('exposure') ? PROBE_EXPOSURE : 2,
    quality: (query.has('quality') ? PROBE_QUALITY : 'medium') as 'low' | 'medium',
  };
})();
const FLIGHT_PROBE_ENABLED = (import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV
  && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('flightProbe') === '1';
const FlightScene = memo(function FlightScene({ session, report, cameraMode, paused }: { session: FlightSession; report: (data: Instruments) => void; cameraMode: FlightSession['camera']; paused: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  const settlingFrames = useRef(0);
  // A single paused-camera frame leaves temporal clouds at their noisy initial
  // sample. Medium's column cache takes 64 frames (1024 rows / 16 per frame),
  // followed by two 16-frame Bayer cycles. Then demand mode sleeps.
  // This renders only: FlightSession.advance remains inert while paused.
  useEffect(() => {
    settlingFrames.current = paused ? 96 : 0;
    invalidate();
  }, [cameraMode, paused, invalidate]);
  const aircraft = useRef<Group>(null);
  const skyLight = useRef<HemisphereLight>(null);
  const terrainSourceRef = useRef<TerrainTileSource | null>(null);
  const frame = useMemo(() => new WorldFrame(flightWorldFrame(session.state.position_N_m).position), [session]);
  const exposureRef = useMemo(() => ({ current: FLIGHT_ENVIRONMENT.exposure }), []);
  const scratch = useMemo(() => ({ matrix: new Matrix4(), forward: new Vector3(), right: new Vector3(), down: new Vector3() }), []);
  const elapsed = useRef(0);
  useFrame(({ camera }, delta) => {
    // Queue one frame at a time: unrelated R3F updates can replace a bulk
    // invalidate(n) request with a single frame while assets finish loading.
    // Asset completion invalidates once. Preserve the budget until then,
    // rather than spending it on frames with no cloud history to accumulate.
    if (settlingFrames.current > 0 && libraryStatus.state === 'ready') {
      settlingFrames.current -= 1;
      if (settlingFrames.current > 0) invalidate();
    }
    session.advance(delta);
    const f = flightWorldFrame(session.state.position_N_m);
    skyLight.current?.position.fromArray(f.up);
    const q_NB = conjugateQuaternion(session.state.q_BN);
    const bodyDirection = (v: Vec3) => f.direction(rotateVector(q_NB, v));
    const offset = bodyDirection(session.camera === 'CHASE' ? [-34, 0, -10] : [5.9, 0, -1.4]);
    const eye: Vec3 = [f.position[0] + offset[0], f.position[1] + offset[1], f.position[2] + offset[2]];
    frame.rebase(eye);
    camera.position.fromArray(frame.toRender(eye));
    camera.up.fromArray(session.camera === 'CHASE' ? f.up : bodyDirection([0, 0, -1]));
    const ahead = bodyDirection([session.camera === 'CHASE' ? 12 : 100, 0, 0]);
    camera.lookAt(...frame.toRender([f.position[0] + ahead[0], f.position[1] + ahead[1], f.position[2] + ahead[2]]));
    if (aircraft.current) {
      aircraft.current.position.fromArray(frame.toRender(f.position));
      aircraft.current.quaternion.setFromRotationMatrix(scratch.matrix.makeBasis(scratch.forward.fromArray(bodyDirection([1, 0, 0])), scratch.right.fromArray(bodyDirection([0, 1, 0])), scratch.down.fromArray(bodyDirection([0, 0, 1]))));
      aircraft.current.visible = session.camera === 'CHASE';
    }
    elapsed.current += delta;
    if (elapsed.current >= 0.1) { report(session.instruments()); elapsed.current = 0; }
  }, -2);
  return <>
    <color attach="background" args={['#8eb1c7']} />
    <hemisphereLight ref={skyLight} args={['#d8edff', '#44515a', 0.8]} />
    {/* The camera is the render origin each frame; this fixed offset preserves sun direction. */}
    <directionalLight position={SUN_DIR.clone().multiplyScalar(SUN_LIGHT_DISTANCE_M / SKY_CONFIG.renderScaleMPerUnit)} intensity={2.4} />
    <Suspense fallback={null}><Earth worldFrame={frame} terrainSourceRef={terrainSourceRef} libraryRenderer /></Suspense>
    <group ref={aircraft} scale={1 / SKY_CONFIG.renderScaleMPerUnit}><HornetModel session={session} /></group>
    <LibraryEffects
      worldFrame={frame}
      exposureRef={exposureRef}
      cloudSystem="eve"
      quality={FLIGHT_ENVIRONMENT.quality}
      exposure={FLIGHT_ENVIRONMENT.exposure}
      dpr={FLIGHT_ENVIRONMENT.dpr}
    />
  </>;
});

function HoldControl({ session, code, children }: { session: FlightSession; code: string; children: React.ReactNode }) {
  const release = (event: React.PointerEvent<HTMLButtonElement>) => session.pointer(code, event.pointerId, false);
  return <button type="button" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); session.pointer(code, event.pointerId, true); }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}>{children}</button>;
}

export function FlightMode() {
  const [session] = useState(() => new FlightSession());
  const [data, setData] = useState(() => session.instruments());
  const root = useRef<HTMLElement>(null);
  const report = useCallback((next: Instruments) => setData(next), []);
  useEffect(() => {
    root.current?.focus();
    const down = (event: KeyboardEvent) => {
      if (handleFlightKeyDown(event, session, event.target instanceof HTMLElement ? event.target : null)) {
        report(session.instruments());
      }
    };
    const up = (event: KeyboardEvent) => { if (FLIGHT_KEYS.has(event.code)) session.key(event.code, false); };
    const blur = () => { session.loseFocus(); report(session.instruments()); };
    const visibility = () => { if (document.hidden) blur(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
    return () => { session.releaseControls(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); };
  }, [session, report]);
  const act = (action: () => void) => { action(); report(session.instruments()); };
  const status = data.status === 'CONTACT' ? 'SURFACE CONTACT · RESET TO FLY' : data.status === 'ENVELOPE' ? 'PROTOTYPE LIMIT · RESET TO FLY' : session.paused ? 'PAUSED · P TO RESUME' : Math.abs(degrees(data.alpha_rad)) > 20 ? 'HIGH ANGLE OF ATTACK' : data.airspeed_m_s < 90 ? 'LOW AIRSPEED' : 'FREE FLIGHT';
  return <section className="flight-mode" ref={root} tabIndex={0} aria-label="F/A-18 flight simulator">
    <Canvas frameloop={session.paused ? 'demand' : 'always'} dpr={FLIGHT_ENVIRONMENT.dpr} gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }} camera={{ fov: 52, near: 0.3, far: 30000000 }} onCreated={({ gl }) => { gl.toneMapping = NoToneMapping; }}>
      <FlightScene session={session} report={report} cameraMode={session.camera} paused={session.paused} />
    </Canvas>
    <header className="flight-title"><span>FLIGHT LAB / 01</span><h1>F/A-18C <small>Flight dynamics prototype</small></h1><p>Equatorial ocean · airborne start · no weapons</p></header>
    <div className="flight-status" role="status">{status}</div>
    <div className="flight-instruments" aria-label="Flight instruments">
      <div className="flight-number"><span>TRUE AIRSPEED</span><strong data-testid="airspeed">{(data.airspeed_m_s * 1.943844).toFixed(0)} <small>KT</small></strong><em>M {data.mach.toFixed(2)} · GS {(data.groundSpeed_m_s * 1.943844).toFixed(0)} KT</em></div>
      <div className="flight-attitude" aria-label={`Bank ${degrees(data.bank_rad).toFixed(0)} degrees, pitch ${degrees(data.pitch_rad).toFixed(0)} degrees`}>
        <div className="flight-attitude-world" style={{ transform: `rotate(${-degrees(data.bank_rad)}deg)` }}><div className="flight-attitude-horizon" style={{ transform: `translateY(${degrees(data.pitch_rad) * 1.4}px)` }}><span>+10</span><hr /><span>−10</span></div></div><div className="flight-wings">━ • ━</div>
      </div>
      <div className="flight-number"><span>ALTITUDE MSL</span><strong data-testid="altitude">{(data.altitude_m * 3.28084).toFixed(0)} <small>FT</small></strong><em>V/S {(data.verticalSpeed_m_s * 196.8504).toFixed(0)} FT/MIN</em></div>
    </div>
    <aside className="flight-panel">
      <div className="flight-panel-top"><span>FLIGHT DATA</span><b>{data.time_s.toFixed(1)} s</b></div>
      <dl><dt>Heading</dt><dd>{degrees(data.heading_rad).toFixed(0).padStart(3, '0')}°</dd>
        <dt>Bank / pitch</dt><dd data-testid="attitude">{degrees(data.bank_rad).toFixed(1)}° / {degrees(data.pitch_rad).toFixed(1)}°</dd>
        <dt>Angle of attack</dt><dd>{degrees(data.alpha_rad).toFixed(1)}°</dd>
        <dt>Sideslip</dt><dd>{degrees(data.beta_rad).toFixed(1)}°</dd>
        <dt>Normal load</dt><dd>{data.normalLoad_g.toFixed(2)} g</dd>
        <dt>Thrust</dt><dd>{(data.thrust_N / 1000).toFixed(1)} kN</dd>
        <dt>Pitch trim</dt><dd>{(session.controls.trim * 100).toFixed(1)}%</dd></dl>
      <label className="flight-throttle">THROTTLE <b>{(session.controls.throttle * 100).toFixed(0)}% {session.controls.throttle > 0.8 ? 'AB' : ''}</b><input aria-label="Throttle" type="range" min="0" max="100" value={session.controls.throttle * 100} onChange={(e) => { session.setThrottle(Number(e.target.value) / 100); report(session.instruments()); }} /></label>
      <label className="flight-wind">Wind <select aria-label="Wind" value={session.environment.wind_N_m_s[1]} onChange={(e) => { session.setWind([0, Number(e.target.value), 0]); report(session.instruments()); }}><option value="0">Calm</option><option value="10">10 m/s toward east</option></select></label>
      <div className="flight-actions"><button type="button" onClick={() => act(() => session.togglePause())}>{session.paused ? 'Resume · P' : 'Pause · P'}</button><button type="button" onClick={() => act(() => session.reset())}>Reset · R</button></div>
      <button className="flight-camera-button" type="button" onClick={() => act(() => { session.camera = session.camera === 'CHASE' ? 'NOSE' : 'CHASE'; })}>Camera: {session.camera.toLowerCase()} · C</button>
    </aside>
    {FLIGHT_PROBE_ENABLED && <FlightExercisePanel session={session} report={() => report(session.instruments())} />}
    <footer className="flight-controls"><div><b>FLY</b> W / S pitch · A / D yaw · Q / E roll · Shift / Ctrl throttle · [ / ] trim</div>
      <div className="flight-touch-controls"><HoldControl session={session} code="KeyS">Nose up</HoldControl><HoldControl session={session} code="KeyW">Nose down</HoldControl><HoldControl session={session} code="KeyQ">Roll left</HoldControl><HoldControl session={session} code="KeyE">Roll right</HoldControl><HoldControl session={session} code="KeyA">Yaw left</HoldControl><HoldControl session={session} code="KeyD">Yaw right</HoldControl></div>
      <p>Engineering approximation · not a validated F/A-18 flight model · 50 km / 20 km altitude / M 0.95 limits · pauses on focus loss</p>
    </footer>
  </section>;
}

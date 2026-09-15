import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Matrix4, NoToneMapping, Vector3, PerspectiveCamera, type Group, type Texture } from 'three';
import { conjugateQuaternion, rotateVector, type Vec3 } from '@docking/sim-core';
import { Earth } from '../scene/Earth';
import { WorldFrame } from '../scene/worldFrame';
import { updateWorldToECEF } from '../scene/libraryFrame';
import { SKY_CONFIG } from '../scene/sky/skyConfig';
import { LibraryEffects, libraryStatus } from '../scene/LibraryEffects';
import type { TerrainTileSource } from '../scene/terrain/tileSource';
import { Airfield } from '../airfield/Airfield';
import {
  AIRFIELD_ANCHOR_N_M,
  AIRFIELD_MAX_WALK_DISTANCE_M,
  AIRFIELD_SPAWN_YAW_RAD,
  airfieldGroundHeight,
} from '../airfield/airfieldSite';
import { CharacterHud } from '../character/CharacterHud';
import { characterRouteFromSearch, CharacterSession } from '../character/characterSession';
import { useCharacterInput } from '../character/useCharacterInput';
import { flightWorldFrame } from './flightFrame';
import { FLIGHT_KEYS, FlightSession } from './flightSession';
import { handleFlightKeyDown } from './flightInput';
import { FlightExercisePanel } from './FlightExercisePanel';
import { CLOUD_BASE_FLIGHT_FIXTURE } from './flightFixture';
import { FlightEvidenceCapture } from './FlightEvidenceCapture';
import { FlightLighting } from './FlightLighting';
import { FlightEnvironmentPanel } from './FlightEnvironmentPanel';
import { FlightEnvironmentClock, subscribeEnvironmentToFlightReset } from './flightEnvironment';
import {
  resolveFlightGraphics,
  resolveFlightRenderSize,
  writeFlightGraphicsPreset,
  type FlightGraphicsConfig,
  type FlightGraphicsHardware,
  type FlightGraphicsPreset,
} from './flightGraphics';
import { FlightGraphicsPanel } from './FlightGraphicsPanel';
import { createFlightCloudLightingBridge } from '../scene/flightCloudLighting';
import { HornetModel } from './HornetModel';
import './flight.css';

type Instruments = ReturnType<FlightSession['instruments']>;
const degrees = (rad: number) => rad * 180 / Math.PI;
const FLIGHT_QUERY = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
const FLIGHT_PROBE_ENABLED = (import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV
  && typeof window !== 'undefined' && FLIGHT_QUERY.get('flightProbe') === '1';
const FLIGHT_FIXTURE = FLIGHT_PROBE_ENABLED && typeof window !== 'undefined'
  && FLIGHT_QUERY.get('flightFixture') === 'cloud-base' ? CLOUD_BASE_FLIGHT_FIXTURE : null;
const FLIGHT_DYNAMIC_ENVIRONMENT = !FLIGHT_FIXTURE
  || FLIGHT_QUERY.get('environment') === 'dynamic'
  || FLIGHT_QUERY.get('flightEnvironment') === 'dynamic';
const FLIGHT_CAMERA_NEAR = 0.3 / SKY_CONFIG.renderScaleMPerUnit;
const CHARACTER_CAMERA_NEAR = 0.1 / SKY_CONFIG.renderScaleMPerUnit;
function FlightGraphicsResolution({ graphics, onResolved }: {
  graphics: FlightGraphicsConfig; onResolved: (dpr: number) => void;
}) {
  const { gl, size } = useThree();
  const resolution = resolveFlightRenderSize(size.width, size.height, graphics.dpr,
    gl.capabilities.maxTextureSize, graphics.scenePixelCap);
  useEffect(() => {
    // Canvas receives this same capped value. Mutating only R3F's viewport DPR
    // would let the next parent render configure the uncapped value again.
    onResolved(resolution.dpr);
  }, [onResolved, resolution.dpr]);
  return null;
}
const FlightScene = memo(function FlightScene({ session, character, baseRoute, parked, terrainSourceRef, report, onCharacterUpdate, cameraMode, paused, environment, captureRequest, onCaptured, onInvalidate, graphics, onResolution }: {
  session: FlightSession;
  character: CharacterSession | null;
  baseRoute: boolean;
  parked: boolean;
  terrainSourceRef: { current: TerrainTileSource | null };
  report: (data: Instruments) => void;
  onCharacterUpdate: () => void;
  cameraMode: FlightSession['camera'];
  paused: boolean;
  environment: FlightEnvironmentClock | null;
  captureRequest: number;
  onCaptured: (message: string) => void;
  onInvalidate: (invalidate: () => void) => void;
  graphics: FlightGraphicsConfig;
  onResolution: (dpr: number) => void;
}) {
  const { invalidate, size } = useThree();
  const settlingFrames = useRef(0);
  const environmentDiscontinuity = useRef(environment?.state.discontinuityRevision ?? 0);
  // A single paused-camera frame leaves temporal clouds at their noisy initial
  // sample. Medium's column cache takes 64 frames (1024 rows / 16 per frame),
  // followed by two 16-frame Bayer cycles. Then demand mode sleeps.
  // This renders only: FlightSession.advance remains inert while paused.
  useEffect(() => {
    settlingFrames.current = paused ? 96 : 0;
    invalidate();
  }, [cameraMode, graphics.dpr, graphics.preset, graphics.quality, graphics.smaa.preset, paused, size.width, size.height, invalidate]);
  useEffect(() => {
    onInvalidate(invalidate);
    return () => onInvalidate(() => undefined);
  }, [invalidate, onInvalidate]);
  const aircraft = useRef<Group>(null);
  const daylightRef = useRef(1);
  const sunTransmittanceRef = useRef<Texture | null>(null);
  const skyIrradianceRef = useRef<Texture | null>(null);
  const cloudLighting = useMemo(() => createFlightCloudLightingBridge(), []);
  const localCloudLighting = graphics.source === 'legacy-fixture' ? undefined : cloudLighting;
  const frame = useMemo(() => new WorldFrame(flightWorldFrame(session.state.position_N_m).position), [session]);
  const exposureRef = useMemo(() => ({ current: graphics.exposure }), []);
  const scratch = useMemo(() => ({ matrix: new Matrix4(), forward: new Vector3(), right: new Vector3(), down: new Vector3() }), []);
  const elapsed = useRef(0);
  useFrame(({ camera }, delta) => {
    // Queue one frame at a time: unrelated R3F updates can replace a bulk
    // invalidate(n) request with a single frame while assets finish loading.
    // Asset completion invalidates once. Preserve the budget until then,
    // rather than spending it on frames with no cloud history to accumulate.
    if (environment && environment.state.discontinuityRevision !== environmentDiscontinuity.current) {
      environmentDiscontinuity.current = environment.state.discontinuityRevision;
      settlingFrames.current = 96;
      invalidate();
    }
    if (environment) {
      const ownerPaused = character?.paused ?? session.paused;
      if (environment.state.paused !== ownerPaused) environment.setPaused(ownerPaused);
      environment.advance(delta);

    }
    if (settlingFrames.current > 0 && libraryStatus.state === 'ready') {
      settlingFrames.current -= 1;
      if (settlingFrames.current > 0) invalidate();
    }
    if (character === null) session.advance(delta);
    else character.advance(delta);
    const f = flightWorldFrame(session.state.position_N_m);
    const q_NB = conjugateQuaternion(session.state.q_BN);
    const bodyDirection = (v: Vec3) => f.direction(rotateVector(q_NB, v));
    const onFoot = character?.mode === 'ON_FOOT';
    const near = onFoot ? CHARACTER_CAMERA_NEAR : FLIGHT_CAMERA_NEAR;
    const fov = onFoot ? 80 : 52;
    if (camera.near !== near || (camera instanceof PerspectiveCamera && camera.fov !== fov)) {
      camera.near = near;
      if (camera instanceof PerspectiveCamera) camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    if (onFoot && character !== null) {
      const pose = character.camera;
      frame.rebase(pose.eyeWorld);
      camera.position.fromArray(frame.toRender(pose.eyeWorld));
      camera.up.fromArray(pose.upWorld);
      camera.lookAt(...frame.toRender([
        pose.eyeWorld[0] + pose.forwardWorld[0] * 100,
        pose.eyeWorld[1] + pose.forwardWorld[1] * 100,
        pose.eyeWorld[2] + pose.forwardWorld[2] * 100,
      ]));
    } else {
      const offset = bodyDirection(session.camera === 'CHASE' ? [-34, 0, -10] : [5.9, 0, -1.4]);
      const eye: Vec3 = [f.position[0] + offset[0], f.position[1] + offset[1], f.position[2] + offset[2]];
      frame.rebase(eye);
      camera.position.fromArray(frame.toRender(eye));
      camera.up.fromArray(session.camera === 'CHASE' ? f.up : bodyDirection([0, 0, -1]));
      const ahead = bodyDirection([session.camera === 'CHASE' ? 12 : 100, 0, 0]);
      camera.lookAt(...frame.toRender([f.position[0] + ahead[0], f.position[1] + ahead[1], f.position[2] + ahead[2]]));
    }
    if (aircraft.current) {
      aircraft.current.position.fromArray(frame.toRender(f.position));
      aircraft.current.quaternion.setFromRotationMatrix(scratch.matrix.makeBasis(scratch.forward.fromArray(bodyDirection([1, 0, 0])), scratch.right.fromArray(bodyDirection([0, 1, 0])), scratch.down.fromArray(bodyDirection([0, 0, 1]))));
      aircraft.current.visible = onFoot || session.camera === 'CHASE';
    }
    // Keep the local PBR hook in physical ECEF metres after every camera
    // rebase. The bridge's Matrix4 and all material uniform identities remain
    // stable across quality changes and StrictMode replay.
    updateWorldToECEF(frame, cloudLighting.renderToECEF);
    elapsed.current += delta;
    if (elapsed.current >= 0.1) {
      if (character === null) report(session.instruments());
      else onCharacterUpdate();
      elapsed.current = 0;
    }
  }, -2);
  return <>
    <FlightGraphicsResolution graphics={graphics} onResolved={onResolution} />
    <FlightLighting worldFrame={frame} environment={environment ?? undefined} localShadows={baseRoute} daylightRef={daylightRef} sunTransmittanceRef={sunTransmittanceRef} skyIrradianceRef={skyIrradianceRef} shadowMapSize={graphics.shadowMapSize} />
    <Suspense fallback={null}><Earth worldFrame={frame} terrainSourceRef={terrainSourceRef} /></Suspense>
    {baseRoute && <Airfield worldFrame={frame} daylightRef={daylightRef} anisotropy={graphics.anisotropy} cloudLighting={localCloudLighting} />}
    <group ref={aircraft} scale={1 / SKY_CONFIG.renderScaleMPerUnit}><HornetModel session={session} parked={parked} anisotropy={graphics.anisotropy} cloudLighting={localCloudLighting} /></group>
    <LibraryEffects
      worldFrame={frame}
      exposureRef={exposureRef}
      cloudSystem="volumetric"
      quality={graphics.quality}
      exposure={graphics.exposure}
      dpr={graphics.dpr}
      graphicsPreset={graphics.preset}
      smaa={{ enabled: graphics.smaa.enabled, preset: graphics.smaa.preset }}
      environment={environment ?? undefined}
      sunTransmittanceRef={sunTransmittanceRef}
      skyIrradianceRef={skyIrradianceRef}
      cloudLighting={localCloudLighting}
    />
    {FLIGHT_FIXTURE && <FlightEvidenceCapture session={session} environment={environment ?? undefined} fixtureName={FLIGHT_FIXTURE.name} request={captureRequest} quality={graphics.quality} onSaved={onCaptured} />}
    {FLIGHT_PROBE_ENABLED && baseRoute && <FlightEvidenceCapture session={session} character={character ?? undefined} environment={environment ?? undefined} fixtureName="base" request={captureRequest} quality={graphics.quality} onSaved={onCaptured} />}
  </>;
});

function HoldControl({ session, code, children, disabled = false }: { session: FlightSession; code: string; children: React.ReactNode; disabled?: boolean }) {
  const release = (event: React.PointerEvent<HTMLButtonElement>) => session.pointer(code, event.pointerId, false);
  return <button type="button" disabled={disabled} onPointerDown={(event) => { if (disabled) return; event.currentTarget.setPointerCapture(event.pointerId); session.pointer(code, event.pointerId, true); }}
    onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}>{children}</button>;
}

export function FlightMode() {
  const terrainSourceRef = useRef<TerrainTileSource | null>(null);
  const invalidateEnvironmentRef = useRef<(() => void) | null>(null);
  const [canvasDpr, setCanvasDpr] = useState(1);
  const onResolution = useCallback((dpr: number) => setCanvasDpr(dpr), []);
  const [hardware, setHardware] = useState<FlightGraphicsHardware>();
  const [userGraphicsPreset, setUserGraphicsPreset] = useState<FlightGraphicsPreset | null>(null);
  const graphics = useMemo(() => resolveFlightGraphics(FLIGHT_QUERY, {
    fixture: Boolean(FLIGHT_FIXTURE),
    hardware,
    selectedPreset: userGraphicsPreset ?? undefined,
  }), [hardware, userGraphicsPreset]);
  const [environment] = useState(() => new FlightEnvironmentClock({ paused: Boolean(FLIGHT_FIXTURE) }));
  const activeEnvironment = FLIGHT_DYNAMIC_ENVIRONMENT ? environment : null;
  const [session] = useState(() => {
    const next = new FlightSession();
    if (FLIGHT_FIXTURE) next.applyFixture(FLIGHT_FIXTURE);
    return next;
  });
  const route = useMemo(() => characterRouteFromSearch(), []);
  const [character] = useState(() => {
    if (FLIGHT_FIXTURE || !route.enabled) return null;
    return new CharacterSession({
      flight: session,
      start: route.start,
      terrainSourceRef,
      spawnSideOffsetM: 11.5,
      groundSampler: route.start === 'GROUND' ? airfieldGroundHeight : undefined,
      fixtureAnchor_N_m: AIRFIELD_ANCHOR_N_M,
      initialYawRad: AIRFIELD_SPAWN_YAW_RAD,
      maxDistanceM: AIRFIELD_MAX_WALK_DISTANCE_M,
    });
  });
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [data, setData] = useState(() => session.instruments());
  const [captureRequest, setCaptureRequest] = useState(0);
  const [captureStatus, setCaptureStatus] = useState('');
  const root = useRef<HTMLElement>(null);
  const report = useCallback((next: Instruments) => setData(next), []);
  const reportCharacter = useCallback(() => {
    activeEnvironment?.setPaused(character?.paused ?? session.paused);
    setData(session.instruments());
  }, [activeEnvironment, character, session]);
  const setEnvironmentInvalidate = useCallback((invalidate: () => void) => {
    invalidateEnvironmentRef.current = invalidate;
  }, []);
  const { focusRoot } = useCharacterInput({
    enabled: character !== null,
    session: character,
    rootRef: root,
    canvas,
    onChange: reportCharacter,
  });
  useEffect(() => {
    root.current?.focus();
    if (character !== null) return undefined;
    const down = (event: KeyboardEvent) => {
      if (handleFlightKeyDown(event, session, event.target instanceof HTMLElement ? event.target : null)) {
        report(session.instruments());
      }
    };
    const up = (event: KeyboardEvent) => { if (FLIGHT_KEYS.has(event.code)) session.key(event.code, false); };
    const blur = () => { session.loseFocus(); activeEnvironment?.loseFocus(); report(session.instruments()); };
    const visibility = () => { if (document.hidden) blur(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
    return () => { session.releaseControls(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); };
  }, [activeEnvironment, character, session, report]);
  const act = (action: () => void) => {
    action();
    activeEnvironment?.setPaused(character?.paused ?? session.paused);
    report(session.instruments());
    if (character !== null) focusRoot();
  };
  const resetGame = () => act(() => {
    if (character !== null) character.reset();
    else session.reset();
  });
  useEffect(() => {
    if (!activeEnvironment) return;
    return subscribeEnvironmentToFlightReset(activeEnvironment, session, character, () => {
      invalidateEnvironmentRef.current?.();
    });
  }, [activeEnvironment, character, session]);
  const resetEnvironment = () => {
    if (!activeEnvironment) return;
    activeEnvironment.reset(activeEnvironment.state.paused);
    invalidateEnvironmentRef.current?.();
  };
  const changeGraphicsPreset = (preset: FlightGraphicsPreset) => {
    if (!uiPaused || preset === graphics.preset && graphics.source === 'ui') return;
    setUserGraphicsPreset(preset);
    writeFlightGraphicsPreset(preset);
  };
  const onFoot = character?.mode === 'ON_FOOT';
  const parked = character?.parked ?? false;
  const uiPaused = character?.paused ?? session.paused;
  const baseRoute = character?.start === 'GROUND';
  const status = data.status === 'CONTACT' ? 'SURFACE CONTACT · RESET TO FLY' : data.status === 'ENVELOPE' ? 'PROTOTYPE LIMIT · RESET TO FLY' : session.paused ? 'PAUSED · P TO RESUME' : Math.abs(degrees(data.alpha_rad)) > 20 ? 'HIGH ANGLE OF ATTACK' : data.airspeed_m_s < 90 ? 'LOW AIRSPEED' : 'FREE FLIGHT';
  return <section className="flight-mode" ref={root} tabIndex={0} aria-label="F/A-18 flight simulator">
    <Canvas shadows={baseRoute ? 'soft' : false} frameloop={uiPaused ? 'demand' : 'always'} dpr={canvasDpr} gl={{ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }} camera={{ fov: 52, near: 0.3, far: 30000000 }} onCreated={({ gl }) => {
      gl.toneMapping = NoToneMapping;
      let maxAnisotropy = 1;
      try { maxAnisotropy = gl.capabilities.getMaxAnisotropy(); } catch { /* Some WebGL implementations omit anisotropy. */ }
      setHardware({ maxTextureSize: gl.capabilities.maxTextureSize, maxAnisotropy });
      if (character !== null) setCanvas(gl.domElement);
    }}>
      <FlightScene session={session} character={character} baseRoute={baseRoute} parked={parked} terrainSourceRef={terrainSourceRef} report={report} onCharacterUpdate={reportCharacter} cameraMode={session.camera} paused={uiPaused} environment={activeEnvironment} captureRequest={captureRequest} onCaptured={setCaptureStatus} onInvalidate={setEnvironmentInvalidate} graphics={graphics} onResolution={onResolution} />
    </Canvas>
    <header className="flight-title"><span>FLIGHT LAB / 01</span><h1>F/A-18C <small>{baseRoute ? 'Runway 18 / 36' : 'Flight dynamics prototype'}</small></h1><p>{character === null ? 'Equatorial ocean · airborne start · no weapons' : baseRoute ? 'Flight base · hangars · landing pad' : 'Airborne vehicle · character controls'}</p></header>
    <div className={`flight-control-stack${!onFoot && !parked ? ' is-airborne' : ''}`}>
      {activeEnvironment && <FlightEnvironmentPanel environment={activeEnvironment} onTogglePause={() => act(() => { if (character !== null) character.togglePause(); else session.togglePause(); })} onReset={resetEnvironment} onChanged={() => invalidateEnvironmentRef.current?.()} />}
      <FlightGraphicsPanel graphics={graphics} paused={uiPaused} onPresetChange={changeGraphicsPreset} />
    </div>
    {character === null && <div className="flight-status" role="status">{status}</div>}
    {!onFoot && !parked && <div className="flight-instruments" aria-label="Flight instruments">
      <div className="flight-number"><span>TRUE AIRSPEED</span><strong data-testid="airspeed">{(data.airspeed_m_s * 1.943844).toFixed(0)} <small>KT</small></strong><em>M {data.mach.toFixed(2)} · GS {(data.groundSpeed_m_s * 1.943844).toFixed(0)} KT</em></div>
      <div className="flight-attitude" aria-label={`Bank ${degrees(data.bank_rad).toFixed(0)} degrees, pitch ${degrees(data.pitch_rad).toFixed(0)} degrees`}>
        <div className="flight-attitude-world" style={{ transform: `rotate(${-degrees(data.bank_rad)}deg)` }}><div className="flight-attitude-horizon" style={{ transform: `translateY(${degrees(data.pitch_rad) * 1.4}px)` }}><span>+10</span><hr /><span>−10</span></div></div><div className="flight-wings">━ • ━</div>
      </div>
      <div className="flight-number"><span>ALTITUDE MSL</span><strong data-testid="altitude">{(data.altitude_m * 3.28084).toFixed(0)} <small>FT</small></strong><em>V/S {(data.verticalSpeed_m_s * 196.8504).toFixed(0)} FT/MIN</em></div>
    </div>}
    {!onFoot && !parked && <aside className="flight-panel">
      <div className="flight-panel-top"><span>FLIGHT DATA</span><b>{data.time_s.toFixed(1)} s</b></div>
      <dl><dt>Heading</dt><dd>{degrees(data.heading_rad).toFixed(0).padStart(3, '0')}°</dd>
        <dt>Bank / pitch</dt><dd data-testid="attitude">{degrees(data.bank_rad).toFixed(1)}° / {degrees(data.pitch_rad).toFixed(1)}°</dd>
        <dt>Angle of attack</dt><dd>{degrees(data.alpha_rad).toFixed(1)}°</dd>
        <dt>Sideslip</dt><dd>{degrees(data.beta_rad).toFixed(1)}°</dd>
        <dt>Normal load</dt><dd>{data.normalLoad_g.toFixed(2)} g</dd>
        <dt>Thrust</dt><dd>{(data.thrust_N / 1000).toFixed(1)} kN</dd>
        <dt>Pitch trim</dt><dd>{(session.controls.trim * 100).toFixed(1)}%</dd></dl>
      {!parked && <label className="flight-throttle">THROTTLE <b>{(session.controls.throttle * 100).toFixed(0)}% {session.controls.throttle > 0.8 ? 'AB' : ''}</b><input aria-label="Throttle" type="range" min="0" max="100" value={session.controls.throttle * 100} onChange={(e) => { session.setThrottle(Number(e.target.value) / 100); report(session.instruments()); }} /></label>}
      {!parked && <label className="flight-wind">Wind <select aria-label="Wind" value={session.environment.wind_N_m_s[1]} onChange={(e) => { session.setWind([0, Number(e.target.value), 0]); report(session.instruments()); }}><option value="0">Calm</option><option value="10">10 m/s toward east</option></select></label>}
      <div className="flight-actions"><button type="button" onClick={() => act(() => { if (character !== null) character.togglePause(); else session.togglePause(); })}>{uiPaused ? 'Resume · P' : 'Pause · P'}</button><button type="button" onClick={resetGame}>Reset · R</button></div>
      <button className="flight-camera-button" type="button" onClick={() => act(() => { session.camera = session.camera === 'CHASE' ? 'NOSE' : 'CHASE'; })}>Camera: {session.camera.toLowerCase()} · C</button>
    </aside>}
    {FLIGHT_PROBE_ENABLED && !parked && <FlightExercisePanel session={session} report={() => report(session.instruments())} fixtureName={FLIGHT_FIXTURE?.name} captureStatus={captureStatus} onCapture={FLIGHT_FIXTURE ? () => { setCaptureStatus('Capturing…'); setCaptureRequest((value) => value + 1); } : undefined} />}
    {FLIGHT_PROBE_ENABLED && baseRoute && <aside className="flight-exercise-panel" aria-label="Base evidence capture">
      <div className="flight-panel-top"><span>DEV EVIDENCE</span><b>BASE</b></div>
      <button className="flight-camera-button" type="button" onClick={() => { setCaptureStatus('Capturing…'); setCaptureRequest((value) => value + 1); }}>Capture base evidence</button>
      {captureStatus && <small>{captureStatus}</small>}
      <small>Passive capture includes the real character pose and camera metadata.</small>
    </aside>}
    {!onFoot && !parked && <footer className="flight-controls"><div><b>FLY</b> W / S pitch · A / D yaw · Q / E roll · Shift / Ctrl throttle · [ / ] trim</div>
      <div className="flight-touch-controls"><HoldControl session={session} code="KeyS" disabled={parked}>Nose up</HoldControl><HoldControl session={session} code="KeyW" disabled={parked}>Nose down</HoldControl><HoldControl session={session} code="KeyQ" disabled={parked}>Roll left</HoldControl><HoldControl session={session} code="KeyE" disabled={parked}>Roll right</HoldControl><HoldControl session={session} code="KeyA" disabled={parked}>Yaw left</HoldControl><HoldControl session={session} code="KeyD" disabled={parked}>Yaw right</HoldControl></div>
      <p>Engineering approximation · not a validated F/A-18 flight model · 50 km / 20 km altitude / M 0.95 limits · pauses on focus loss</p>
    </footer>}
    {character !== null && <CharacterHud session={character} onChange={reportCharacter} focusRoot={focusRoot} />}
  </section>;
}

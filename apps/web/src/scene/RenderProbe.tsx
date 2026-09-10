import { useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, Vector3 } from 'three';
import { Html } from '@react-three/drei';
import { WorldFrame } from './worldFrame';
import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M } from './sky/skyConfig';
import { parseFlytoParam } from './flytoParam';
import { useViewStore } from '../viewStore';
import { LIBRARY_RENDERER, PROBE_CLOUDS, PROBE_DPR, PROBE_PROFILE, PROBE_QUALITY, PROBE_WEATHER, PROBE_WEATHER_STRUCTURE } from './renderProbeConfig';
import { libraryStatus } from './LibraryEffects';
import { cloudShadowProbe } from './libraryCloudShadowDiagnostics';
import { renderTimings } from './renderTimings';
import { renderEvidenceName } from './renderEvidenceName';
import { runCloudConformance, type CloudConformanceReport } from './clouds/CloudConformanceFixture';

const sites = { Reference: [40.5, -75], Formation: [40.88, -75.42], KSC: [28.6, -80.6], Mountains: [27.98, 86.92], Night: [-28.6, 99.4] } as const;
const MAX_SAMPLES = 900; // Fifteen minutes at 1 Hz, including the planned ten-minute soak.
type SweepDirection = 'descending' | 'ascending';
interface ProbeClock {
  last: number;
  start: number;
  frames: number;
  rebases: number;
  anchor: readonly number[];
  runStart: number;
  sweepDirection: SweepDirection | null;
  contextReady: boolean;
  samples: object[];
}
export function RenderProbe({ worldFrame }: { worldFrame: WorldFrame }) {
  const renderer = useThree(state => state.gl);
  const query = new URLSearchParams(window.location.search);
  const flightQuery = new URLSearchParams(query);
  flightQuery.delete('fixture');
  const selected = useRef({ lat: Number(query.get('flyto')?.split(',')[0] ?? 28.6), lon: Number(query.get('flyto')?.split(',')[1] ?? -80.6), altitude: Number(query.get('flyto')?.split(',')[2] ?? 400000), pitch: Number(query.get('pitch') ?? '-20'), yaw: Number(query.get('yaw') ?? '90') });
  const probeAnchor = useRef<Group>(null);
  const direction = useRef(new Vector3());
  const capture = useRef(false);
  const recordVideo = useRef(false);
  const recorder = useRef<MediaRecorder>();
  const [saved, setSaved] = useState('');
  const [text, setText] = useState('Measuring…');
  const [conformance, setConformance] = useState<CloudConformanceReport>();
  const conformanceBusy = useRef(false);
  const history = useRef<number[]>([]);
  const clock = useRef<ProbeClock>({ last: performance.now(), start: performance.now(), frames: 0, rebases: 0, anchor: worldFrame.anchor, runStart: 0, sweepDirection: null, contextReady: false, samples: [] });
  function pose(teleport = true) {
    const p = selected.current;
    const spawn = parseFlytoParam(`?flyto=${p.lat},${p.lon},${p.altitude}`)!;
    const view = useViewStore.getState();
    if (teleport) {
      view.setMode('DEBUG');
      if (useViewStore.getState().debugSubmode !== 'FLY') view.toggleDebugSubmode();
      view.setFlyPose(spawn.positionM, p.yaw * Math.PI / 180, p.pitch * Math.PI / 180);
    } else {
      // A continuous sweep must not announce another teleport every frame.
      view.setFlyPosition(spawn.positionM);
    }
  }
  function startSweep(direction: SweepDirection): void {
    clock.current.runStart = performance.now();
    clock.current.sweepDirection = direction;
    clock.current.samples = [];
    selected.current.altitude = direction === 'descending' ? 400000 : 50;
    pose();
  }
  useFrame(({ camera, gl }, delta) => {
    renderTimings.updateRendererContext(gl, LIBRARY_RENDERER ? 'library' : 'legacy', PROBE_DPR);
    if (!clock.current.contextReady) {
      if (!LIBRARY_RENDERER) renderTimings.setBufferContext({ owner: 'canvas' });
      clock.current.contextReady = true;
    }
    if (!LIBRARY_RENDERER) renderTimings.beginFrame();
    camera.getWorldDirection(direction.current);
    probeAnchor.current?.position.copy(camera.position).add(direction.current);
    const c = clock.current; const now = performance.now();
    if (recordVideo.current) {
      recordVideo.current = false;
      const stream = gl.domElement.captureStream(60);
      const recording = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 5000000 });
      recorder.current = recording;
      const chunks: Blob[] = [];
      const name = `descent-${Date.now()}`;
      recording.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recording.onstop = () => {
        stream.getTracks().forEach(track => track.stop()); recorder.current = undefined;
        const reader = new FileReader();
        reader.onload = () => { void fetch('/__render-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, video: reader.result, samples: c.samples, context: { url: window.location.href, ...selected.current, dpr: PROBE_DPR, profile: PROBE_PROFILE, videoRecording: true, sweep: 'descending', quality: PROBE_QUALITY, weather: PROBE_WEATHER, weatherStructure: PROBE_WEATHER_STRUCTURE, shadow: { ...cloudShadowProbe } } }) }).then(r => setSaved(r.ok ? name : 'Video save failed')); };
        reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
      };
      selected.current.altitude = 400000; pose();
      c.runStart = now; c.sweepDirection = 'descending'; c.samples = []; recording.start(); setSaved('Recording descent');
    }
    if (capture.current) {
      capture.current = false;
      const p = selected.current;
      const backend = LIBRARY_RENDERER ? (query.get('cloudSystem') === 'eve' ? 'eve' : 'lib') : 'old';
      const name = renderEvidenceName(backend, PROBE_QUALITY, query.get('stage'));
      void fetch('/__render-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, image: gl.domElement.toDataURL('image/png'), samples: c.samples, context: { url: window.location.href, ...p, shadow: { ...cloudShadowProbe }, dpr: PROBE_DPR, profile: PROBE_PROFILE, videoRecording: recorder.current?.state === 'recording', sweep: c.sweepDirection, drawingBuffer: [gl.domElement.width, gl.domElement.height], userAgent: navigator.userAgent } })
      }).then(r => r.ok ? setSaved(name) : setSaved('Capture failed'));
    }
    if (c.runStart) {
      const progress = Math.min(1, (now - c.runStart) / 30000);
      const altitudeExponent = c.sweepDirection === 'ascending' ? progress : 1 - progress;
      selected.current.altitude = 50 * Math.pow(8000, altitudeExponent); pose(false);
      if (progress === 1) { c.runStart = 0; c.sweepDirection = null; if (recorder.current?.state === 'recording') recorder.current.stop(); }
    }
    history.current.push(delta * 1000); c.frames++;
    if (worldFrame.anchor.some((n, i) => n !== c.anchor[i])) { c.rebases++; c.anchor = worldFrame.anchor; }
    if (now - c.last < 1000) return;
    c.last = now;
    const p = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    const sorted = history.current.splice(0).sort((a, b) => a - b);
    const timingSnapshot = renderTimings.snapshot();
    const sample = {
      seconds: +((now - c.start) / 1000).toFixed(1), renderer: LIBRARY_RENDERER ? 'library' : 'legacy',
      profile: PROBE_PROFILE, clouds: PROBE_CLOUDS, quality: PROBE_QUALITY, weather: PROBE_WEATHER, dpr: PROBE_DPR, state: LIBRARY_RENDERER ? libraryStatus.state : 'ready',
      altitudeMSL: Math.round(Math.hypot(p[0] + EARTH_CENTER_DISTANCE_M, p[1], p[2]) - EARTH_RADIUS_M),
      latitude: +(Math.atan2(p[1], Math.hypot(p[0] + EARTH_CENTER_DISTANCE_M, p[2])) * 180 / Math.PI).toFixed(4),
      longitude: +(Math.atan2(-p[2], p[0] + EARTH_CENTER_DISTANCE_M) * 180 / Math.PI).toFixed(4),
      pitch: +(Math.asin(Math.max(-1, Math.min(1, direction.current.dot(new Vector3(p[0] + EARTH_CENTER_DISTANCE_M, p[1], p[2]).normalize())))) * 180 / Math.PI).toFixed(2),
      fps: +(1000 / (sorted.reduce((a,b) => a + b, 0) / sorted.length)).toFixed(1),
      p95ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1), frames: c.frames, rebases: c.rebases,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures,
      tiles: (globalThis as { __tileDiag?: object }).__tileDiag ?? null,
      run: c.runStart ? c.sweepDirection : 'idle', videoRecording: recorder.current?.state === 'recording', visibility: document.visibilityState, error: libraryStatus.error,
      shadows: cloudShadowProbe.mode, cloudOverlay: cloudShadowProbe.overlay,
      weatherStructure: PROBE_WEATHER_STRUCTURE, waterReflections: cloudShadowProbe.waterReflections,
      shadowFarM: libraryStatus.shadowRange?.farM ?? null, shadowTexelM: libraryStatus.shadowTexelM,
      lightingSelection: libraryStatus.lightingSelection,
      // Status is mutated in place by the renderer. Retaining it here rewrites
      // every historical sample to the final frame's representation/state.
      eve: structuredClone(libraryStatus.eve),
      timings: timingSnapshot, conformance,
    };
    c.samples.push(sample);
    if (c.samples.length > MAX_SAMPLES) c.samples.splice(0, c.samples.length - MAX_SAMPLES);
    setText(JSON.stringify(sample));
  }, 3);
  return <group ref={probeAnchor}><Html fullscreen onOcclude={() => { /* Screen-fixed controls never occlude. */ }} calculatePosition={(_object, _camera, size) => [size.width / 2, size.height / 2]} style={{ pointerEvents: 'none' }}><aside style={{ position: 'absolute', right: 12, top: 70, width: 335, background: '#07111ee8', color: '#dfefff', padding: 10, font: '12px monospace', pointerEvents: 'auto', zIndex: 100 }}>
    <strong>Renderer feasibility probe</strong>
    {query.get('fixture') === 'clouds' && <div role="status" style={{ margin: '8px 0', padding: 10, background: '#253b52', lineHeight: 1.5 }}>
      <strong>Cloud test mode</strong>
      <div>Earth is hidden in this test view. The black background is expected.</div>
      <a href={`?${flightQuery}`} style={{ color: '#bfe5ff' }}>Return to flight</a>
    </div>}
    <div>{Object.entries(sites).map(([name, coords]) => <button key={name} onClick={() => { selected.current.lat = coords[0]; selected.current.lon = coords[1]; pose(); }}>{name}</button>)}</div>
    <div>{[400000, 120000, 100000, 70000, 20000, 3000, 1000, 50].map(a => <button key={a} onClick={() => { clock.current.runStart = 0; clock.current.sweepDirection = null; selected.current.altitude = a; pose(); }}>{a >= 1000 ? `${a / 1000} km` : `${a} m`}</button>)}</div>
    <div>{[-80, -45, -20, -10, 0, 30].map(p => <button key={p} onClick={() => { selected.current.pitch = p; pose(); }}>Pitch {p}°</button>)}</div>
    <div>{[0, 90, 180, 270].map(y => <button key={y} onClick={() => { selected.current.yaw = y; pose(); }}>Yaw {y}°</button>)}</div>
    <button onClick={() => startSweep('descending')}>Descend 400 km → 50 m (30s)</button>
    <button onClick={() => startSweep('ascending')}>Ascend 50 m → 400 km (30s)</button>
    <button onClick={() => { recordVideo.current = true; }}>Record descent video</button>
    <div>profile=1: {PROBE_PROFILE ? 'on' : 'off'} · video: {recorder.current?.state === 'recording' ? 'on' : 'off'}</div>
    <div>{(['on', 'off', 'mask'] as const).map(mode => <button key={mode} onClick={() => { cloudShadowProbe.mode = mode; }}>Shadows {mode}</button>)}
      <button onClick={() => { cloudShadowProbe.overlay = !cloudShadowProbe.overlay; }}>Toggle cloud visibility</button></div>
    <div>{(['lighting', 'normals'] as const).map(mode => <button key={mode} onClick={() => { cloudShadowProbe.mode = mode; }}>Inspect {mode}</button>)}</div>
    <div>{(['fitted', 'original'] as const).map(range => <button key={range} onClick={() => { cloudShadowProbe.range = range; }}>Shadow range {range}</button>)}</div>
    <div>{[true, false].map(enabled => <button key={String(enabled)} onClick={() => { cloudShadowProbe.waterReflections = enabled; }}>Water reflections {enabled ? 'on' : 'off'}</button>)}</div>
    <button onClick={() => { capture.current = true; }}>Capture evidence</button><span>{saved}</span>
    {query.get('cloudSystem') === 'eve' && <>
      <button disabled={conformanceBusy.current} onClick={() => {
        if (conformanceBusy.current) return;
        conformanceBusy.current = true;
        setSaved('Running production cloud shader fixtures');
        void runCloudConformance(renderer).then(setConformance).finally(() => {
          conformanceBusy.current = false;
          setSaved('Cloud shader fixtures finished');
        });
      }}>Run cloud conformance</button>
      <output data-testid="cloud-conformance" style={{ display: 'block', maxHeight: 140, overflow: 'auto' }}>{JSON.stringify(conformance ?? { status: 'not-run' })}</output>
    </>}
    <button onClick={() => {
      const name = `timings-${PROBE_CLOUDS ? 'clouds' : 'clear'}-${Date.now()}`;
      void fetch('/__render-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, samples: clock.current.samples, context: { url: window.location.href, ...selected.current, profile: PROBE_PROFILE, videoRecording: false, sampleLimit: MAX_SAMPLES } })
      }).then(r => setSaved(r.ok ? name : 'Timing save failed'));
    }}>Save timing evidence</button>
    <button onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(clock.current.samples, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'renderer-probe.json'; a.click(); URL.revokeObjectURL(url);
    }}>Save measurements</button>
    <output data-testid="render-probe" style={{ display: 'block', overflowWrap: 'anywhere', marginTop: 8, maxHeight: 220, overflow: 'auto' }}>{text}</output>
  </aside></Html></group>;
}

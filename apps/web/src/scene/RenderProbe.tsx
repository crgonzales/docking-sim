import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group, Vector3 } from 'three';
import { Html } from '@react-three/drei';
import { WorldFrame } from './worldFrame';
import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M } from './sky/skyConfig';
import { parseFlytoParam } from './flytoParam';
import { useViewStore } from '../viewStore';
import { LIBRARY_RENDERER, PROBE_CLOUDS, PROBE_DPR, PROBE_QUALITY, PROBE_WEATHER, PROBE_WEATHER_STRUCTURE } from './renderProbeConfig';
import { libraryStatus } from './LibraryEffects';
import { cloudShadowProbe } from './libraryCloudShadowDiagnostics';

const sites = { KSC: [28.6, -80.6], Mountains: [27.98, 86.92], Night: [-28.6, 99.4] } as const;
export function RenderProbe({ worldFrame }: { worldFrame: WorldFrame }) {
  const query = new URLSearchParams(window.location.search);
  const selected = useRef({ lat: Number(query.get('flyto')?.split(',')[0] ?? 28.6), lon: Number(query.get('flyto')?.split(',')[1] ?? -80.6), altitude: Number(query.get('flyto')?.split(',')[2] ?? 400000), pitch: Number(query.get('pitch') ?? '-20'), yaw: Number(query.get('yaw') ?? '90') });
  const probeAnchor = useRef<Group>(null);
  const direction = useRef(new Vector3());
  const capture = useRef(false);
  const recordVideo = useRef(false);
  const recorder = useRef<MediaRecorder>();
  const [saved, setSaved] = useState('');
  const [text, setText] = useState('Measuring…');
  const history = useRef<number[]>([]);
  const clock = useRef({ last: performance.now(), start: performance.now(), frames: 0, rebases: 0, anchor: worldFrame.anchor, runStart: 0, samples: [] as object[] });
  function pose() {
    const p = selected.current;
    const spawn = parseFlytoParam(`?flyto=${p.lat},${p.lon},${p.altitude}`)!;
    const view = useViewStore.getState();
    view.setMode('DEBUG');
    if (useViewStore.getState().debugSubmode !== 'FLY') view.toggleDebugSubmode();
    view.setFlyPose(spawn.positionM, p.yaw * Math.PI / 180, p.pitch * Math.PI / 180);
  }
  useFrame(({ camera, gl }, delta) => {
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
        reader.onload = () => { void fetch('/__render-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, video: reader.result, samples: c.samples, context: { url: window.location.href, ...selected.current, dpr: PROBE_DPR, quality: PROBE_QUALITY, weather: PROBE_WEATHER, weatherStructure: PROBE_WEATHER_STRUCTURE, shadow: { ...cloudShadowProbe } } }) }).then(r => setSaved(r.ok ? name : 'Video save failed')); };
        reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
      };
      c.runStart = now; c.samples = []; recording.start(); setSaved('Recording descent');
    }
    if (capture.current) {
      capture.current = false;
      const p = selected.current;
      const name = `${LIBRARY_RENDERER ? 'lib' : 'old'}-${PROBE_QUALITY}-c${+PROBE_CLOUDS}-${PROBE_WEATHER}-${PROBE_WEATHER_STRUCTURE}-w${+cloudShadowProbe.waterReflections}-d${PROBE_DPR}-${p.lat}-${p.lon}-${Math.round(p.altitude)}m-p${p.pitch}-y${p.yaw}-${cloudShadowProbe.range}-${cloudShadowProbe.mode}-o${+cloudShadowProbe.overlay}`.replaceAll('.', '_');
      void fetch('/__render-evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, image: gl.domElement.toDataURL('image/png'), samples: c.samples, context: { url: window.location.href, ...p, shadow: { ...cloudShadowProbe }, dpr: PROBE_DPR, drawingBuffer: [gl.domElement.width, gl.domElement.height], userAgent: navigator.userAgent } })
      }).then(r => r.ok ? setSaved(name) : setSaved('Capture failed'));
    }
    if (c.runStart) {
      const progress = Math.min(1, (now - c.runStart) / 30000);
      selected.current.altitude = 50 * Math.pow(8000, 1 - progress); pose();
      if (progress === 1) { c.runStart = 0; if (recorder.current?.state === 'recording') recorder.current.stop(); }
    }
    history.current.push(delta * 1000); c.frames++;
    if (worldFrame.anchor.some((n, i) => n !== c.anchor[i])) { c.rebases++; c.anchor = worldFrame.anchor; }
    if (now - c.last < 1000) return;
    c.last = now;
    const p = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    const sorted = history.current.splice(0).sort((a, b) => a - b);
    const sample = {
      seconds: +((now - c.start) / 1000).toFixed(1), renderer: LIBRARY_RENDERER ? 'library' : 'legacy',
      clouds: PROBE_CLOUDS, quality: PROBE_QUALITY, weather: PROBE_WEATHER, dpr: PROBE_DPR, state: LIBRARY_RENDERER ? libraryStatus.state : 'ready',
      altitudeMSL: Math.round(Math.hypot(p[0] + EARTH_CENTER_DISTANCE_M, p[1], p[2]) - EARTH_RADIUS_M),
      latitude: +(Math.atan2(p[1], Math.hypot(p[0] + EARTH_CENTER_DISTANCE_M, p[2])) * 180 / Math.PI).toFixed(4),
      longitude: +(Math.atan2(-p[2], p[0] + EARTH_CENTER_DISTANCE_M) * 180 / Math.PI).toFixed(4),
      pitch: +(Math.asin(Math.max(-1, Math.min(1, direction.current.dot(new Vector3(p[0] + EARTH_CENTER_DISTANCE_M, p[1], p[2]).normalize())))) * 180 / Math.PI).toFixed(2),
      fps: +(1000 / (sorted.reduce((a,b) => a + b, 0) / sorted.length)).toFixed(1),
      p95ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1), frames: c.frames, rebases: c.rebases,
      geometries: gl.info.memory.geometries, textures: gl.info.memory.textures,
      tiles: (globalThis as { __tileDiag?: object }).__tileDiag ?? null,
      run: c.runStart ? 'descending' : 'idle', error: libraryStatus.error,
      shadows: cloudShadowProbe.mode, cloudOverlay: cloudShadowProbe.overlay,
      weatherStructure: PROBE_WEATHER_STRUCTURE, waterReflections: cloudShadowProbe.waterReflections,
      shadowFarM: libraryStatus.shadowRange?.farM ?? null, shadowTexelM: libraryStatus.shadowTexelM,
      lightingSelection: libraryStatus.lightingSelection,
    };
    c.samples.push(sample);
    setText(JSON.stringify(sample));
  }, 3);
  return <group ref={probeAnchor}><Html fullscreen onOcclude={() => { /* Screen-fixed controls never occlude. */ }} calculatePosition={(_object, _camera, size) => [size.width / 2, size.height / 2]} style={{ pointerEvents: 'none' }}><aside style={{ position: 'absolute', right: 12, top: 70, width: 335, background: '#07111ee8', color: '#dfefff', padding: 10, font: '12px monospace', pointerEvents: 'auto', zIndex: 100 }}>
    <strong>Renderer feasibility probe</strong>
    <div>{Object.entries(sites).map(([name, coords]) => <button key={name} onClick={() => { selected.current.lat = coords[0]; selected.current.lon = coords[1]; pose(); }}>{name}</button>)}</div>
    <div>{[400000, 120000, 100000, 70000, 20000, 3000, 1000, 50].map(a => <button key={a} onClick={() => { clock.current.runStart = 0; selected.current.altitude = a; pose(); }}>{a >= 1000 ? `${a / 1000} km` : `${a} m`}</button>)}</div>
    <div>{[-80, -45, -20, -10, 0, 30].map(p => <button key={p} onClick={() => { selected.current.pitch = p; pose(); }}>Pitch {p}°</button>)}</div>
    <div>{[0, 90, 180, 270].map(y => <button key={y} onClick={() => { selected.current.yaw = y; pose(); }}>Yaw {y}°</button>)}</div>
    <button onClick={() => { clock.current.runStart = performance.now(); clock.current.samples = []; }}>Descend 400 km → 50 m (30s)</button>
    <button onClick={() => { recordVideo.current = true; }}>Record descent video</button>
    <div>{(['on', 'off', 'mask'] as const).map(mode => <button key={mode} onClick={() => { cloudShadowProbe.mode = mode; }}>Shadows {mode}</button>)}
      <button onClick={() => { cloudShadowProbe.overlay = !cloudShadowProbe.overlay; }}>Toggle cloud visibility</button></div>
    <div>{(['lighting', 'normals'] as const).map(mode => <button key={mode} onClick={() => { cloudShadowProbe.mode = mode; }}>Inspect {mode}</button>)}</div>
    <div>{(['fitted', 'original'] as const).map(range => <button key={range} onClick={() => { cloudShadowProbe.range = range; }}>Shadow range {range}</button>)}</div>
    <div>{[true, false].map(enabled => <button key={String(enabled)} onClick={() => { cloudShadowProbe.waterReflections = enabled; }}>Water reflections {enabled ? 'on' : 'off'}</button>)}</div>
    <button onClick={() => { capture.current = true; }}>Capture evidence</button><span>{saved}</span>
    <button onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(clock.current.samples, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'renderer-probe.json'; a.click(); URL.revokeObjectURL(url);
    }}>Save measurements</button>
    <output data-testid="render-probe" style={{ display: 'block', overflowWrap: 'anywhere', marginTop: 8 }}>{text}</output>
  </aside></Html></group>;
}

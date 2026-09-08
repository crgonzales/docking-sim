/* Run: node apps/web/scripts/terrain-spike-lifecycle.cjs
 * Executes the real component, tile cache, worker queue and node policy with
 * React hooks/fetch/worker transport stubbed. No browser/server or GPU needed.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { root, terrain, webRequire, baselineModule, config, quadtree: q, nodes, worker: tw, heightField: hf, R, position, selectionOptions } = require('./terrain-spike-tools.cjs');
const { Group, PerspectiveCamera, Texture } = webRequire('three');
const { WorldFrame } = require(path.join(terrain, '../worldFrame.ts'));
const tileModule = require(path.join(terrain, 'tileSource.ts'));
const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness({ baseline = false, realGeometry = false, delayBase = false, hero = false, selection = selectionOptions, opaque = false } = {}) {
  const refs = [], effects = [], active = [], submissions = [], coverage = [];
  let frame, source, pool, lastDesired, recordsRef, displayedRef, buildsRef;
  let baseHeld = delayBase, heroHeld = hero;
  const baseWaiters = [], heroWaiters = [];
  const camera = new PerspectiveCamera(45, 1280 / 720, 0.1, 1e9);
  camera.position.fromArray(position(3000));
  const policy = baseline ? baselineModule('apps/web/src/scene/terrain/terrainNodeSet.ts') : nodes;
  const oldLoad = Module._load, oldFetch = globalThis.fetch;
  const manifest = { tileSize: 2, maxLevel: 3, codec: hf.DEFAULT_TERRAIN_RGB_CODEC, urlTemplate: '/base/{face}/{level}/{x}/{y}.png' };
  const response = value => ({ ok: true, status: 200, json: async () => value, blob: async () => value });
  globalThis.fetch = async url => {
    if (url.endsWith('/hero/manifest.json')) return response({ regions: hero ? [{
      urlTemplate: '/hero/ksc/{level}/{x}/{y}.png', codec: manifest.codec,
      region: { id: 'ksc', bounds: { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 } },
    }] : [] });
    if (url.includes('/hero/ksc/')) {
      if (heroHeld) await new Promise(resolve => heroWaiters.push(resolve));
      return response(null);
    }
    return response(manifest);
  };
  class Source extends tileModule.TerrainTileSource {
    constructor(m, options) {
      super(m, { ...options,
        fetcher: async url => {
          const level = Number(url.split('/')[3]);
          if (baseHeld && level > 0) await new Promise(resolve => baseWaiters.push(resolve));
          return response(null);
        },
        decoder: async (_, address, codec) => ({ address, width: 2, height: 2, codec,
          data: new Float32Array(4).fill(address.level === 0 ? 100 : 500),
        }),
      });
      source = this;
    }
  }
  class Pool extends tw.TerrainWorkerPool {
    constructor() {
      super({ workerCount: 4, maxConcurrentBuilds: 4, workerFactory: () => {
        const transport = { onmessage: null, onerror: null, terminated: false,
          postMessage(request) { active.push({ transport, request }); submissions.push(request); },
          terminate() { this.terminated = true; },
        };
        return transport;
      } });
      pool = this;
    }
  }
  Module._load = function(request, parent, isMain) {
    if (request === 'react') return {
      useRef(value) { const ref = { current: value }; refs.push(ref); return ref; },
      useMemo: fn => fn(), useEffect: fn => effects.push(fn),
    };
    if (request === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
    if (request === '@react-three/fiber') return { useFrame: fn => { frame = fn; }, useThree: () => ({ camera, size: { height: 720, width: 1280 } }) };
    if (parent?.filename.endsWith('TerrainPatches.tsx')) {
      if (request === './terrainWorker') return { ...tw, TerrainWorkerPool: Pool };
      if (request === './tileSource') return { ...tileModule, TerrainTileSource: Source,
        decodeTerrainRgbBlob: async () => ({ width: 2, height: 2, data: new Float32Array(4).fill(2000) }),
      };
      if (request === './terrainNodeSet') return { ...policy, selectTerrainNodes: (pos, options) => {
        lastDesired = policy.selectTerrainNodes(pos, { ...options, ...selection });
        return lastDesired;
      } };
    }
    return oldLoad.apply(this, arguments);
  };
  const filename = path.join(terrain, 'TerrainPatches.tsx');
  delete require.cache[filename];
  let component;
  try { component = baseline ? baselineModule('apps/web/src/scene/terrain/TerrainPatches.tsx') : require(filename); }
  finally { Module._load = oldLoad; }
  const result = component.TerrainPatches({ worldFrame: new WorldFrame(), terrainSourceRef: { current: null }, earthCenterF64: [0, 0, 0],
    dayMap: new Texture(), cloudMap: new Texture(), transmittanceLut: new Texture(), mainDeckRotation: { current: 0 }, radius: R,
    opaque, onCoverageReadyChange: value => coverage.push(value),
  });
  result.props.ref.current = new Group();
  const cleanups = effects.map(fn => fn());
  function snapshot() {
    recordsRef ||= refs.find(ref => ref.current instanceof Map && [...ref.current.values()][0]?.result);
    displayedRef ||= refs.find(ref => Array.isArray(ref.current) && ref.current.length && ref.current[0]?.face !== undefined && ref.current !== lastDesired);
    buildsRef ||= refs.find(ref => ref.current instanceof Map && typeof [...ref.current.values()][0] === 'symbol');
    const records = recordsRef?.current || new Map();
    const displayed = displayedRef?.current || [];
    const pendingKeys = baseline ? active.filter(a => !a.transport.terminated).map(a => q.nodeAddressKey(a.request.address)) : [...(buildsRef?.current.keys() || [])];
    return { records, displayed, desired: lastDesired || [],
      occupied: new Set([...records.keys(), ...pendingKeys]).size,
      built: records.size, active: active.filter(a => !a.transport.terminated).length,
      submitted: submissions.length, coverage: [...coverage],
    };
  }
  function complete() {
    for (const { transport, request } of active.splice(0)) {
      if (transport.terminated) continue;
      let data;
      if (realGeometry) data = tw.buildPatchGeometry({ ...request, detail: { baseAmplitudeM: 0 } });
      else {
        const center = q.nodeCenterDirection(request.address).map(n => n * (R + 100));
        data = { type: 'patchBuilt', requestId: request.requestId, address: request.address, patchCenterF64: center,
          positions: new Float32Array(3).buffer, normals: new Float32Array(q.nodeCenterDirection(request.address)).buffer,
          uvs: new Float32Array(2).buffer, indices: new Uint32Array(0).buffer, waterMask: new Uint8Array([0]).buffer,
          waterPositions: new Float32Array(3).buffer,
          vertexCount: 1, indexCount: 0, baseVertexCount: 1, skirtVertexCount: 0, boundingSphereRadiusM: 1,
        };
      }
      transport.onmessage?.({ data });
    }
  }
  return {
    submissions, coverage, camera,
    setPosition: (altitude, lat = 28.6, lon = -80.6) => camera.position.fromArray(position(altitude, lat, lon)),
    snapshot,
    releaseBase() { baseHeld = false; for (const resolve of baseWaiters.splice(0)) resolve(); },
    releaseHero() { heroHeld = false; for (const resolve of heroWaiters.splice(0)) resolve(); },
    async step({ finish = true } = {}) {
      frame({}, 1 / 60); await flush();
      if (finish) { complete(); await flush(); }
      const state = snapshot();
      if (!baseline) {
        assert(state.occupied <= 300, `resident/reserved budget exceeded: ${state.occupied}`);
        if (state.displayed.length) assert(nodes.isTerrainCoverageReady(state.displayed, new Set(state.records.keys())), 'hole or unready displayed patch');
      }
      return state;
    },
    async close() {
      for (const cleanup of cleanups) cleanup?.();
      await flush();
      globalThis.fetch = oldFetch;
    },
  };
}

async function settle(h, frames = 240) {
  let state;
  for (let i = 0; i < frames; i++) state = await h.step();
  const before = state.submitted;
  for (let i = 0; i < 12; i++) state = await h.step();
  assert.equal(state.submitted, before, 'stationary build churn');
  assert.equal(state.active, 0, 'builds never settled');
  assert.deepEqual(state.displayed.map(q.nodeAddressKey), state.desired.map(q.nodeAddressKey), 'failed to converge to desired cover');
  return state;
}

async function main() {
  const legacy = await harness({ baseline: true });
  let original;
  for (let i = 0; i < 240; i++) original = await legacy.step();
  console.log('BASELINE_KSC', { records: original.records.size, displayed: original.displayed.length, desired: original.desired.length });
  assert.equal(original.records.size, 498);
  assert.equal(original.displayed.length, 375);
  await legacy.close();

  const h = await harness({ opaque: true });
  for (const altitudeM of [50, 3000, 20000, 70000, 100000]) {
    h.setPosition(altitudeM);
    const state = await settle(h);
    console.log('PROTOTYPE_SETTLED', { altitudeM, records: state.records.size, displayed: state.displayed.length, desired: state.desired.length, occupied: state.occupied });
    assert.equal(h.coverage.at(-1), true);
    for (const node of state.displayed) {
      const mesh = state.records.get(q.nodeAddressKey(node)).mesh;
      assert.equal(mesh.visible, true, 'opaque cover was horizon-culled');
      assert.equal(mesh.material.uniforms.terrainOpacity.value, 1);
    }
  }
  // A planet-scale jump must coarsen first, then refine within the same cap.
  h.setPosition(3000, -35, 120);
  await settle(h);
  h.setPosition(120000);
  let state = await h.step();
  assert.equal(state.records.size, 0);
  assert.equal(h.coverage.at(-1), false);
  console.log('PROTOTYPE_DORMANT', { altitudeM: 120000, records: state.records.size, displayed: state.displayed.length });
  h.setPosition(3000);
  await settle(h);
  await h.close();
  assert.equal(h.coverage.at(-1), false, 'dispose must withdraw coverage');

  const delayed = await harness({ realGeometry: true, delayBase: true, selection: { ...selectionOptions, maxLevel: 2, maxLivePatches: 30 } });
  for (let i = 0; i < 30; i++) await delayed.step();
  state = delayed.snapshot();
  assert.equal(state.records.size, 6, 'refinement built without required base tiles');
  assert(delayed.submissions.every(request => request.address.level === 0));
  delayed.releaseBase();
  state = await settle(delayed, 50);
  const refined = [...state.records.values()].filter(record => record.result.address.level > 0);
  assert(refined.length > 0);
  for (const record of refined) assert(Math.abs(Math.hypot(...record.result.patchCenterF64) - R - 500) < 0.01);
  console.log('DELAYED_BASE', { before: 'six 100m root fallbacks only', refinedRecords: refined.length, refinedCenterHeightM: 500 });
  await delayed.close();

  const hero = await harness({ hero: true });
  await settle(hero);
  const oldRecords = new Map(hero.snapshot().records);
  hero.releaseHero();
  await flush(); await settle(hero);
  const replaced = [...hero.snapshot().records].filter(([key, record]) => record !== oldRecords.get(key));
  assert(replaced.length > 0);
  assert(replaced.every(([, record]) => record.heroInputKey === 'ksc'));
  console.log('LATE_HERO_REPLACED', replaced.length);
  await hero.close();

  // Hero arrival while builds are active: obsolete payloads cannot be installed.
  const inFlight = await harness({ hero: true });
  await inFlight.step({ finish: false });
  assert(inFlight.submissions.length > 0);
  inFlight.releaseHero(); await flush();
  await settle(inFlight);
  const overlapping = [...inFlight.snapshot().records.values()].filter(record => record.heroInputKey);
  assert(overlapping.length > 0);
  // Fade out with active work, re-enter before old callbacks settle.
  inFlight.setPosition(3000, -35, 120); await inFlight.step({ finish: false });
  inFlight.setPosition(120000); await inFlight.step({ finish: false });
  inFlight.setPosition(3000); await settle(inFlight);
  await inFlight.close();
  console.log('PASS: budgets, complete coverage, camera jumps, no stationary churn, delayed base/hero inputs, epoch cancellation, opaque handoff');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { harness, settle };

/* Run: node apps/web/scripts/terrain-spike-benchmark.cjs */
const { baselineModule, nodes, position, selectionOptions, config, quadtree: q } = require('./terrain-spike-tools.cjs');
const baseline = baselineModule('apps/web/src/scene/terrain/terrainNodeSet.ts');
function measure(select, pos) {
  select(pos, selectionOptions);
  const times = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    select(pos, selectionOptions);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: +times[4].toFixed(3), maxMs: +times[8].toFixed(3) };
}
const rows = [];
for (const altitudeM of [50, 3000, 20000, 70000, 100000, 120000]) {
  const pos = position(altitudeM);
  const statistics = { evaluatedNodes: 0, splits: 0, residentNodes: 0 };
  const result = nodes.selectTerrainNodes(pos, { ...selectionOptions, statistics });
  const uncapped = baseline.selectTerrainNodes(pos, { ...selectionOptions, maxLivePatches: undefined });
  const baselineSelected = baseline.selectTerrainNodes(pos, selectionOptions);
  const nadirLevel = leaves => leaves.find(node => q.nodeAddressKey(q.addressFromDirection(pos, node.level)) === q.nodeAddressKey(node))?.level;
  rows.push({ baselineNadirLevel: nadirLevel(baselineSelected), prototypeNadirLevel: nadirLevel(result), altitudeM, active: config.terrainFadeFromAltitudeM(altitudeM) > 0,
    baselineLeavesBeforeCap: uncapped.length,
    baseline: measure(baseline.selectTerrainNodes, pos), prototype: measure(nodes.selectTerrainNodes, pos),
    evaluatedNodes: statistics.evaluatedNodes, leaves: result.length,
    residentClosure: nodes.terrainResidencyKeys(result).size,
  });
}
console.log(JSON.stringify({ geodetic: [28.6, -80.6], fovDegrees: 45, viewportHeight: 720,
  budget: 300, baseline: 'HEAD terrain selector; identical config and projection',
  note: '120 km is dormant in TerrainPatches; selection there is measured in isolation.', rows }, null, 2));

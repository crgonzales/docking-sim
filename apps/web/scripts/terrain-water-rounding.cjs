/* Run: node apps/web/scripts/terrain-water-rounding.cjs
 * Reproduces the discarded Float32 reprojection path against current water.
 */
const assert = require('node:assert/strict');
const { worker, heightField: hf, quadtree: q, R, position, terrain } = require('./terrain-spike-tools.cjs');
const { buildWaterPatchGeometry, geoidSurfacePosition } = require(`${terrain}/terrainWater.ts`);
const tiles = [0, 1, 2, 3, 4, 5].map(face => ({
  address: { face, level: 0, x: 0, y: 0 }, width: 2, height: 2,
  codec: hf.DEFAULT_TERRAIN_RGB_CODEC, data: new Float32Array(4),
}));
function compare(patch, candidate) {
  const soil = new Float32Array(patch.positions);
  const bits = new Uint32Array(patch.positions);
  const candidateBits = new Uint32Array(candidate.buffer);
  let changed = 0, below = 0, minRadialDeltaM = 0, maxRadialDeltaM = 0;
  for (let index = 0; index < patch.baseVertexCount; index++) {
    if ([0, 1, 2].some(axis => bits[index * 3 + axis] !== candidateBits[index * 3 + axis])) changed++;
    const radial = values => Math.hypot(...patch.patchCenterF64.map((center, axis) => center + values[index * 3 + axis]));
    const delta = radial(candidate) - radial(soil);
    if (delta < 0) below++;
    minRadialDeltaM = Math.min(minRadialDeltaM, delta);
    maxRadialDeltaM = Math.max(maxRadialDeltaM, delta);
  }
  return { changed, below, minRadialDeltaM, maxRadialDeltaM };
}
for (const level of [0, 3, 10]) {
  const address = q.addressFromDirection(position(50), level);
  const patch = worker.buildPatchGeometry({ type: 'buildPatch', address, tiles,
    codec: hf.DEFAULT_TERRAIN_RGB_CODEC, detail: { baseAmplitudeM: 0 }, skirtDepthM: 2,
  });
  const soil = new Float32Array(patch.positions);
  const old = new Float32Array(soil.length);
  for (let index = 0; index < patch.vertexCount; index++) {
    const absolute = patch.patchCenterF64.map((center, axis) => center + soil[index * 3 + axis]);
    const surface = geoidSurfacePosition(absolute, R);
    for (let axis = 0; axis < 3; axis++) old[index * 3 + axis] = surface[axis] - patch.patchCenterF64[axis];
  }
  const before = compare(patch, old);
  const after = compare(patch, new Float32Array(buildWaterPatchGeometry(patch, R).positions));
  assert(before.changed > 0 && before.below > 0, 'reprojection defect was not exercised');
  assert.equal(after.changed, 0, 'zero-height water positions differ from soil');
  assert.equal(after.below, 0, 'zero-height water moved below soil');
  console.log(JSON.stringify({ address, baseVertices: patch.baseVertexCount, before, after }));
}

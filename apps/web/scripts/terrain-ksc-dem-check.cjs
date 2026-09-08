/* Run: node apps/web/scripts/terrain-ksc-dem-check.cjs
 * Read actual shipped PNGs and intercept the worker's height samples in memory.
 * No assets, height physics, browser or server are changed.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { root, terrain, webRequire, worker, heightField: hf, quadtree: q,
  nodes, config, R, position, selectionOptions } = require('./terrain-spike-tools.cjs');
const { PNG } = webRequire('pngjs');
const publicRoot = path.join(root, 'apps/web/public');
const readJson = name => JSON.parse(fs.readFileSync(path.join(publicRoot, name), 'utf8'));
const manifest = readJson('assets/terrain/manifest.json');
const hero = readJson('assets/terrain/hero/manifest.json').regions.find(entry => entry.region.id === 'ksc');
const region = config.SKY_CONFIG.terrain.heroRegions.find(entry => entry.id === 'ksc');
const heroLevel = Number(fs.readFileSync(path.join(terrain, 'TerrainPatches.tsx'), 'utf8').match(/const HERO_TILE_LEVEL = (\d+)/)[1]);
assert.equal(heroLevel, 0, 'This check expects the runtime single-tile hero input');
const decode = (url, address, codec) => {
  const png = PNG.sync.read(fs.readFileSync(path.join(publicRoot, url)));
  return hf.terrainTileFromRgb(address, png.width, png.height, png.data, codec);
};
const heroUrl = hero.urlTemplate.replace('{level}', '0').replace('{x}', '0').replace('{y}', '0');
const heroData = decode(heroUrl, { face: 0, level: 0, x: 0, y: 0 }, hero.codec);
const bounds = hero.region.bounds;
const heroTile = { regionId: 'ksc', tileSize: heroData.width, data: heroData.data,
  bounds: { minLatDeg: bounds.minLat, maxLatDeg: bounds.maxLat, minLonDeg: bounds.minLon, maxLonDeg: bounds.maxLon },
};
function distribution(data) {
  const positive = [...data].filter(value => value > 0).sort((a, b) => a - b);
  const finite = [...data].filter(Number.isFinite);
  return { total: data.length, zero: finite.filter(value => value === 0).length,
    negative: finite.filter(value => value < 0).length, positive: positive.length,
    noData: data.length - finite.length, minM: Math.min(...finite), maxM: Math.max(...finite),
    minPositiveM: positive[0] ?? null,
    positiveBelow1um: positive.filter(value => value < 1e-6).length,
    positiveBelow1mm: positive.filter(value => value < 1e-3).length,
    positiveBelow1cm: positive.filter(value => value < 0.01).length,
    positiveAtMost1m: positive.filter(value => value <= 1).length,
  };
}
console.log('KSC_RUNTIME_RASTER', JSON.stringify({ path: heroUrl, level: heroLevel,
  codec: hero.codec, ...distribution(heroData.data),
  encodedZeroDecodesTo: hf.decodeTerrainRgb(hf.encodeTerrainRgb(0, hero.codec), hero.codec),
}));

const tileCache = new Map();
function baseInputs(address) {
  const required = new Map();
  for (let tile of worker.requiredPatchTileAddresses(address, manifest.maxLevel)) {
    while (tile !== null) {
      const key = q.nodeAddressKey(tile);
      if (required.has(key)) break;
      required.set(key, tile);
      tile = q.parentAddress(tile);
    }
  }
  return [...required].map(([key, tile]) => {
    if (!tileCache.has(key)) {
      const url = manifest.urlTemplate.replace('{face}', tile.face).replace('{level}', tile.level).replace('{x}', tile.x).replace('{y}', tile.y);
      tileCache.set(key, decode(url, tile, manifest.codec));
    }
    return tileCache.get(key);
  });
}
function heroCorners(lat, lon) {
  const latDeg = lat * 180 / Math.PI, lonDeg = lon * 180 / Math.PI;
  if (latDeg < bounds.minLat || latDeg > bounds.maxLat || lonDeg < bounds.minLon || lonDeg > bounds.maxLon) return null;
  const x = (lonDeg - bounds.minLon) / (bounds.maxLon - bounds.minLon) * (heroData.width - 1);
  const y = (bounds.maxLat - latDeg) / (bounds.maxLat - bounds.minLat) * (heroData.height - 1);
  return [Math.floor(y), Math.min(Math.floor(y) + 1, heroData.height - 1)]
    .flatMap(iy => [Math.floor(x), Math.min(Math.floor(x) + 1, heroData.width - 1)].map(ix => heroData.data[iy * heroData.width + ix]));
}
const nadir = hf.directionFromLatLon(region.centerLatDeg * Math.PI / 180, region.centerLonDeg * Math.PI / 180);
const originalHeight = hf.height;
for (const altitudeM of [50, 3000]) {
  const selected = nodes.selectTerrainNodes(position(altitudeM), selectionOptions);
  const overlapping = selected.filter(address => {
    const center = q.nodeCenterDirection(address);
    const distanceKm = Math.acos(Math.max(-1, Math.min(1, center.reduce((sum, value, axis) => sum + value * nadir[axis], 0)))) * R / 1000;
    return distanceKm <= region.radiusKm + region.featherKm + q.nodeAngularRadiusRadians(address) * R / 1000;
  });
  const samples = [];
  let zeroCellSamples = 0, nonzeroFromZeroCell = 0, minPositivePoint = null, currentAddress;
  hf.height = (lat, lon, field) => {
    const value = originalHeight(lat, lon, field);
    const weight = hf.heroWeight(region, lat, lon);
    if (weight <= 0 || value === null) return value;
    samples.push(value);
    const corners = heroCorners(lat, lon);
    if (weight === 1 && corners?.every(height => height === 0)) {
      zeroCellSamples++;
      if (value !== 0) nonzeroFromZeroCell++;
    }
    if (value > 0 && (minPositivePoint === null || value < minPositivePoint.heightM)) {
      minPositivePoint = { address: currentAddress, latDeg: lat * 180 / Math.PI, lonDeg: lon * 180 / Math.PI,
        heightM: value, heroWeight: weight, heroCornerHeightsM: corners,
        baseWithDetailM: originalHeight(lat, lon, { ...field, heroRegions: [] }),
      };
    }
    return value;
  };
  try {
    for (const address of overlapping) {
      currentAddress = address;
      worker.buildPatchGeometry({ type: 'buildPatch', address, tiles: baseInputs(address), codec: manifest.codec,
        heroRegions: [region], heroTiles: [heroTile], planetRadiusM: R,
      });
    }
  } finally { hf.height = originalHeight; }
  assert.equal(nonzeroFromZeroCell, 0, 'Pure zero hero cells acquired nonzero semantic heights');
  console.log('KSC_WORKER_SAMPLES', JSON.stringify({ altitudeM, overlappingPatches: overlapping.length,
    scope: 'centres and base vertices within the 25km hero footprint; real base/hero PNGs and default detail',
    ...distribution(samples), zeroCellSamples, nonzeroFromZeroCell, minPositivePoint,
  }));
}

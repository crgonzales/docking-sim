import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import { PNG } from 'pngjs';
import ts from 'typescript';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, '..');
const cacheDirectory = resolve(scriptDirectory, '.cache');
const outputDirectory = resolve(webDirectory, 'public/assets/terrain/hero');
const combinedManifestPath = resolve(outputDirectory, 'manifest.json');

const TILE_SIZE = 256;
const MAX_LEVEL = 4;
const MAX_OUTPUT_BYTES = 40_000_000;
const NO_DATA_RGB = [255, 255, 255];
const TERRAIN_RGB_CODEC = { offsetM: -10_000, scaleM: 0.1 };
const DEG_PER_RAD = 180 / Math.PI;

const HERO_SOURCES = {
  ksc: {
    sources: [{
      file: 'USGS_13_n29w081.tif',
      url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n29w081/USGS_13_n29w081.tif',
      sha256: '532ab3a4ade336d9a7d266e6745a12f043db928ba8bf28a4576886de421a74cd',
    }],
  },
  'boca-chica': {
    sources: [
      {
        file: 'USGS_13_n27w098.tif',
        url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n27w098/USGS_13_n27w098.tif',
        sha256: '921b5055de2ccc1054a04b712469f858a71db543a7c8ae6780468549ed9ed5bb',
      },
      {
        file: 'USGS_13_n26w098.tif',
        url: 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n26w098/USGS_13_n26w098.tif',
        sha256: '3459fa64c2604935fc648ba0621380a8de5451ff6d643b0e14449861052e30ff',
      },
    ],
  },
};

function encodeTerrainRgb(heightM) {
  if (heightM === null) return NO_DATA_RGB;
  const encoded = Math.max(0, Math.min(16_777_214, Math.round((heightM - TERRAIN_RGB_CODEC.offsetM) / TERRAIN_RGB_CODEC.scaleM)));
  return [Math.floor(encoded / 65_536), Math.floor((encoded % 65_536) / 256), encoded % 256];
}

async function loadHeroConfig() {
  const configPath = resolve(webDirectory, 'src/scene/sky/skyConfig.ts');
  const source = await readFile(configPath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: configPath,
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  const module = await import(moduleUrl);
  const regions = module.SKY_CONFIG?.terrain?.heroRegions;
  if (!Array.isArray(regions)) throw new Error('SKY_CONFIG.terrain.heroRegions is missing or invalid');
  const earthRadiusKm = module.SKY_CONFIG?.earthRadiusKm;
  if (!Number.isFinite(earthRadiusKm) || earthRadiusKm <= 0) throw new Error('SKY_CONFIG.earthRadiusKm is missing or invalid');
  return { earthRadiusKm, regions };
}

async function verifyCache(source) {
  const sourcePath = resolve(cacheDirectory, source.file);
  let bytes;
  try {
    bytes = await readFile(sourcePath);
  } catch (error) {
    throw new Error(`USGS cache is missing at ${sourcePath}; network access is disabled. Expected source: ${source.url}`, { cause: error });
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== source.sha256) throw new Error(`Checksum mismatch for ${sourcePath}: expected ${source.sha256}, got ${digest}`);
  return sourcePath;
}

async function decodeSource(sourcePath) {
  const tiff = await fromFile(sourcePath);
  const image = await tiff.getImage(0);
  const width = image.getWidth();
  const height = image.getHeight();
  if (width !== 10_812 || height !== 10_812) throw new Error(`Unexpected USGS dimensions: ${width}x${height}; expected 10812x10812`);
  // geotiff lazy-resolves directory fields; the accessor methods are the API.
  const bitsPerSample = image.getBitsPerSample();
  const sampleFormat = image.getSampleFormat();
  if (bitsPerSample !== 32 || sampleFormat !== 3) {
    throw new Error(`USGS source must be native float32 (bitsPerSample=32, sampleFormat=3), got ${bitsPerSample}/${sampleFormat}`);
  }
  const values = await image.readRasters({ interleave: true });
  if (!(values instanceof Float32Array) || values.length !== width * height) {
    throw new Error(`Unexpected decoded USGS raster: expected ${width * height} float32 samples`);
  }
  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
  if (Math.abs(minLon) > 180 || Math.abs(maxLon) > 180 || Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) {
    throw new Error(`USGS source is not in geographic coordinates: bbox ${image.getBoundingBox().join(',')}`);
  }
  return {
    width,
    height,
    values,
    noData: image.getGDALNoData(),
    bbox: { minLon, minLat, maxLon, maxLat },
  };
}

function sourceNoData(value, noData) {
  return !Number.isFinite(value) || (noData !== null && value === noData);
}

function sourceAt(source, x, y) {
  if (x < 0 || x > source.width - 1 || y < 0 || y > source.height - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, source.width - 1);
  const y1 = Math.min(y0 + 1, source.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix, iy) => {
    const value = source.values[iy * source.width + ix];
    return sourceNoData(value, source.noData) ? null : value;
  };
  const corners = [
    [at(x0, y0), (1 - tx) * (1 - ty)],
    [at(x1, y0), tx * (1 - ty)],
    [at(x0, y1), (1 - tx) * ty],
    [at(x1, y1), tx * ty],
  ];
  let weighted = 0;
  let weights = 0;
  for (const [value, weight] of corners) {
    if (value !== null) {
      weighted += value * weight;
      weights += weight;
    }
  }
  return weights === 0 ? null : weighted / weights;
}

function sourceAtLatLon(sources, latDeg, lonDeg) {
  for (const source of sources) {
    const { minLon, minLat, maxLon, maxLat } = source.bbox;
    if (lonDeg < minLon || lonDeg > maxLon || latDeg < minLat || latDeg > maxLat) continue;
    const x = (lonDeg - minLon) / (maxLon - minLon) * (source.width - 1);
    const y = (maxLat - latDeg) / (maxLat - minLat) * (source.height - 1);
    const value = sourceAt(source, x, y);
    // Adjacent source tiles overlap by a few samples at the seam. If the
    // first candidate is no-data there, try the other cached tile before
    // declaring the coordinate outside both sources.
    if (value !== null) return value;
  }
  return null;
}

function regionBounds(region, earthRadiusKm) {
  const extentKm = region.radiusKm + region.featherKm;
  const latDelta = extentKm / earthRadiusKm * DEG_PER_RAD;
  const lonDelta = extentKm / (earthRadiusKm * Math.max(Math.cos(region.centerLatDeg / DEG_PER_RAD), 0.01)) * DEG_PER_RAD;
  return {
    minLat: region.centerLatDeg - latDelta,
    maxLat: region.centerLatDeg + latDelta,
    minLon: region.centerLonDeg - lonDelta,
    maxLon: region.centerLonDeg + lonDelta,
  };
}

function sampleRegion(sources, bounds, u, v) {
  const lat = bounds.maxLat + (bounds.minLat - bounds.maxLat) * v;
  const lon = bounds.minLon + (bounds.maxLon - bounds.minLon) * u;
  return sourceAtLatLon(sources, lat, lon);
}

function regionTilePng(sources, bounds, tileX, tileY, resolution) {
  const data = Buffer.alloc(TILE_SIZE * TILE_SIZE * 3);
  for (let py = 0; py < TILE_SIZE; py += 1) {
    for (let px = 0; px < TILE_SIZE; px += 1) {
      const value = sampleRegion(
        sources,
        bounds,
        (tileX * TILE_SIZE + px + 0.5) / resolution,
        (tileY * TILE_SIZE + py + 0.5) / resolution,
      );
      const [r, g, b] = encodeTerrainRgb(value);
      const offset = (py * TILE_SIZE + px) * 3;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
    }
  }
  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  png.data = data;
  return PNG.sync.write(png, {
    colorType: 2,
    inputColorType: 2,
    inputHasAlpha: false,
    bitDepth: 8,
  });
}

async function emitRegionLevel(sources, region, bounds, level) {
  const resolution = TILE_SIZE * 2 ** level;
  const tileCount = 2 ** level;
  const levelDirectory = resolve(outputDirectory, region.id, String(level));
  await mkdir(levelDirectory, { recursive: true });
  let bytes = 0;
  let tileFiles = 0;
  for (let y = 0; y < tileCount; y += 1) {
    for (let x = 0; x < tileCount; x += 1) {
      const pngBytes = regionTilePng(sources, bounds, x, y, resolution);
      const xDirectory = resolve(levelDirectory, String(x));
      await mkdir(xDirectory, { recursive: true });
      await writeFile(resolve(xDirectory, `${y}.png`), pngBytes);
      bytes += pngBytes.byteLength;
      tileFiles += 1;
    }
  }
  return { level, resolution, tileFiles, bytes };
}

function sampleWindow(sources, centerLat, centerLon, halfWidthDeg, steps) {
  const values = [];
  for (let row = 0; row <= steps; row += 1) {
    const lat = centerLat + (row / steps * 2 - 1) * halfWidthDeg;
    for (let column = 0; column <= steps; column += 1) {
      const lon = centerLon + (column / steps * 2 - 1) * halfWidthDeg;
      const value = sourceAtLatLon(sources, lat, lon);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

function assertKsc(sources, region) {
  const landWindow = sampleWindow(sources, region.centerLatDeg, region.centerLonDeg, 0.015, 6);
  const lowLandSamples = landWindow.filter((value) => value >= 0);
  if (lowLandSamples.length < 10 || Math.max(...lowLandSamples) > 20) {
    throw new Error(`KSC low-coastal assertion failed: expected at least 10 land samples in 0–20 m, got ${lowLandSamples.length === 0 ? 'no data' : `${Math.min(...lowLandSamples)}..${Math.max(...lowLandSamples)}`}`);
  }

  let crossing = null;
  for (let lat = region.centerLatDeg - 0.15; lat <= region.centerLatDeg + 0.15 && crossing === null; lat += 0.005) {
    let previous = sourceAtLatLon(sources, lat, region.centerLonDeg - 0.2);
    for (let lon = region.centerLonDeg - 0.195; lon <= region.centerLonDeg + 0.2 && crossing === null; lon += 0.005) {
      const current = sourceAtLatLon(sources, lat, lon);
      if (previous !== null && current !== null && ((previous < 0 && current >= 0) || (previous >= 0 && current < 0))) {
        crossing = { lat, lon, west: previous, east: current };
      }
      previous = current;
    }
  }
  if (crossing === null) throw new Error('KSC coastline assertion failed: no nearby ocean/land sign crossing found');
  console.log(JSON.stringify({ groundTruth: { kscLand: { min: Math.min(...lowLandSamples), max: Math.max(...lowLandSamples) }, oceanCoastCrossing: crossing } }, null, 2));
}

async function hashDirectory(root) {
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else files.push(path);
    }
  }
  await collect(root);
  files.sort();
  const digest = createHash('sha256');
  for (const path of files) {
    digest.update(relative(root, path).replaceAll('\\', '/'));
    digest.update('\0');
    digest.update(await readFile(path));
  }
  return digest.digest('hex');
}

const { earthRadiusKm, regions: configuredRegions } = await loadHeroConfig();
const regions = configuredRegions.map((region) => {
  if (!HERO_SOURCES[region.id]?.sources?.length) throw new Error(`No pinned USGS source is configured for hero region ${region.id}`);
  if (!Number.isFinite(region.radiusKm) || !Number.isFinite(region.featherKm) || region.radiusKm < 0 || region.featherKm < 0) {
    throw new Error(`Invalid radius or feather for hero region ${region.id}`);
  }
  return { ...region, bounds: regionBounds(region, earthRadiusKm), source: HERO_SOURCES[region.id] };
});

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const levelStats = new Map(regions.map((region) => [region.id, []]));
for (const region of regions) {
  const sources = [];
  for (const sourceConfig of region.source.sources) {
    const sourcePath = await verifyCache(sourceConfig);
    sources.push(await decodeSource(sourcePath));
  }
  if (region.id === 'ksc') assertKsc(sources, region);
  for (let level = 0; level <= MAX_LEVEL; level += 1) {
    levelStats.get(region.id).push(await emitRegionLevel(sources, region, region.bounds, level));
  }
  sources.length = 0;
}

let maxLevel = MAX_LEVEL;
const budgetTable = [];
for (let level = 0; level <= MAX_LEVEL; level += 1) {
  const entries = regions.map((region) => levelStats.get(region.id)[level]);
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const cumulativeBytes = regions.reduce(
    (sum, region) => sum + levelStats.get(region.id).slice(0, level + 1).reduce((levelSum, entry) => levelSum + entry.bytes, 0),
    0,
  );
  budgetTable.push({ level, bytes, cumulativeBytes });
}
while (budgetTable[maxLevel].cumulativeBytes > MAX_OUTPUT_BYTES) {
  if (maxLevel === 0) throw new Error(`Hero DEM level 0 exceeds the ${MAX_OUTPUT_BYTES} byte combined disk budget`);
  for (const region of regions) await rm(resolve(outputDirectory, region.id, String(maxLevel)), { recursive: true, force: true });
  maxLevel -= 1;
}

console.table(budgetTable.map((entry) => ({ ...entry, retained: entry.level <= maxLevel })));
const manifests = regions.map((region) => ({
  tileSize: TILE_SIZE,
  maxLevel,
  urlTemplate: `/assets/terrain/hero/${region.id}/{level}/{x}/{y}.png`,
  format: 'terrain-rgb',
  noDataRgb: NO_DATA_RGB,
  projection: 'local-equirectangular',
  region: {
    id: region.id,
    centerLatDeg: region.centerLatDeg,
    centerLonDeg: region.centerLonDeg,
    radiusKm: region.radiusKm,
    featherKm: region.featherKm,
    bounds: region.bounds,
  },
  codec: TERRAIN_RGB_CODEC,
  sources: region.source.sources.map(({ url, sha256, file }) => ({ file, url, sha256, sampleFormat: 'float32-m' })),
  levels: levelStats.get(region.id).slice(0, maxLevel + 1),
}));
for (const manifest of manifests) {
  await writeFile(resolve(outputDirectory, manifest.region.id, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
const combinedManifest = { format: 'terrain-rgb', regions: manifests };
await writeFile(combinedManifestPath, `${JSON.stringify(combinedManifest, null, 2)}\n`);
const outputSha256 = await hashDirectory(outputDirectory);
console.log(JSON.stringify({
  output: outputDirectory,
  manifest: combinedManifestPath,
  outputSha256,
  maxLevel,
  diskBudgetBytes: MAX_OUTPUT_BYTES,
  levelStats: budgetTable,
}, null, 2));

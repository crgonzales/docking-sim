import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import { PNG } from 'pngjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, '..');
const cacheDirectory = resolve(scriptDirectory, '.cache');
const sourcePath = resolve(cacheDirectory, 'ETOPO_2022_v1_60s_N90W180_surface.tif');
const sourceUrl = 'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif';
const sourceSha256 = '9d27d4b8ea8e76977e2988bca667d7c8fa68b927355feffcddd6b4875a7fd08e';
const outputDirectory = resolve(webDirectory, 'public/assets/terrain/base');
const manifestPath = resolve(webDirectory, 'public/assets/terrain/manifest.json');

const TILE_SIZE = 256;
const CAPPED_SOURCE_WIDTH = 10_800;
const CAPPED_SOURCE_HEIGHT = 5_400;
const TOP_FACE_RESOLUTION = 2 ** Math.ceil(Math.log2(CAPPED_SOURCE_HEIGHT / TILE_SIZE)) * TILE_SIZE;
const CANDIDATE_MAX_LEVEL = Math.log2(TOP_FACE_RESOLUTION / TILE_SIZE);
const MAX_OUTPUT_BYTES = 60_000_000;
const NO_DATA_RGB = [255, 255, 255];
const TERRAIN_RGB_CODEC = { offsetM: -11_000, scaleM: 1 };
const TAU = Math.PI * 2;

async function readAndVerifySource() {
  let bytes;
  try {
    bytes = await readFile(sourcePath);
  } catch (error) {
    throw new Error(`ETOPO cache is missing at ${sourcePath}; network access is disabled. Expected source: ${sourceUrl}`, { cause: error });
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sourceSha256) {
    throw new Error(`Checksum mismatch for ${sourcePath}: expected ${sourceSha256}, got ${digest}`);
  }
}

async function decodeFloatRaster() {
  // geotiff applies TIFF predictor 3 (floating-point horizontal
  // differencing), which utif2 only decompresses and therefore cannot decode
  // for these native float32 elevation rasters.
  const tiff = await fromFile(sourcePath);
  const image = await tiff.getImage(0);
  const width = image.getWidth();
  const height = image.getHeight();
  if (width !== 21_600 || height !== 10_800) throw new Error(`Unexpected ETOPO dimensions: ${width}x${height}; expected 21600x10800`);
  // geotiff lazy-resolves directory fields; the accessor methods are the API.
  const bitsPerSample = image.getBitsPerSample();
  const sampleFormat = image.getSampleFormat();
  if (bitsPerSample !== 32 || sampleFormat !== 3) {
    throw new Error(`ETOPO must be native float32 (bitsPerSample=32, sampleFormat=3), got ${bitsPerSample}/${sampleFormat}`);
  }
  const values = await image.readRasters({ interleave: true });
  if (!(values instanceof Float32Array) || values.length !== width * height) {
    throw new Error(`Unexpected decoded ETOPO raster: expected ${width * height} float32 samples`);
  }
  return { width, height, values, noData: image.getGDALNoData(), sourceSha256 };
}

function isSourceNoData(value, noData) {
  return !Number.isFinite(value) || (noData !== null && value === noData);
}

function wrapUnit(value) {
  return ((value % 1) + 1) % 1;
}

function sourceAt(source, x, y) {
  const wrappedX = ((x % source.width) + source.width) % source.width;
  const clampedY = Math.max(0, Math.min(source.height - 1, y));
  const value = source.values[clampedY * source.width + wrappedX];
  return isSourceNoData(value, source.noData) ? null : value;
}

function sampleSource(source, u, v) {
  // The source-cap coordinates are explicit even though normalized bilinear
  // sampling algebraically reduces to the native grid. This documents that
  // the 21600x10800 source is first treated as a 10800x5400 capped raster.
  const cappedX = wrapUnit(u) * CAPPED_SOURCE_WIDTH - 0.5;
  const cappedY = Math.max(0, Math.min(CAPPED_SOURCE_HEIGHT - 1, v * CAPPED_SOURCE_HEIGHT - 0.5));
  const x = (cappedX + 0.5) * source.width / CAPPED_SOURCE_WIDTH - 0.5;
  const y = (cappedY + 0.5) * source.height / CAPPED_SOURCE_HEIGHT - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = Math.min(y0 + 1, source.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const corners = [
    [sourceAt(source, x0, y0), (1 - tx) * (1 - ty)],
    [sourceAt(source, x1, y0), tx * (1 - ty)],
    [sourceAt(source, x0, y1), (1 - tx) * ty],
    [sourceAt(source, x1, y1), tx * ty],
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

function spherifiedCubeDirection(face, u, v) {
  const s = 2 * u - 1;
  const t = 2 * v - 1;
  let x;
  let y;
  let z;
  switch (face) {
    case 0: [x, y, z] = [1, t, -s]; break;
    case 1: [x, y, z] = [-1, t, s]; break;
    case 2: [x, y, z] = [s, 1, -t]; break;
    case 3: [x, y, z] = [s, -1, t]; break;
    case 4: [x, y, z] = [s, t, 1]; break;
    case 5: [x, y, z] = [-s, t, -1]; break;
    default: throw new Error(`Invalid cube face ${face}`);
  }
  const xScale = Math.sqrt(Math.max(0, 1 - y * y / 2 - z * z / 2 + y * y * z * z / 3));
  const yScale = Math.sqrt(Math.max(0, 1 - z * z / 2 - x * x / 2 + z * z * x * x / 3));
  const zScale = Math.sqrt(Math.max(0, 1 - x * x / 2 - y * y / 2 + x * x * y * y / 3));
  const sx = x * xScale;
  const sy = y * yScale;
  const sz = z * zScale;
  const length = Math.hypot(sx, sy, sz);
  return [sx / length, sy / length, sz / length];
}

function sampleAtLatLon(source, latDeg, lonDeg) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  // Geographic raster u: west edge = 180W. (The equirect raster and the
  // engine's atan2(z,-x) convention are identified through the day texture,
  // so geographic sampling needs the +0.5 raster offset the engine formula
  // already carries via its -x.)
  const u = wrapUnit(lon / TAU + 0.5);
  const v = 0.5 - lat / Math.PI;
  return sampleSource(source, u, v);
}

function sampleWindow(source, centerLatDeg, centerLonDeg, halfWidthDeg, steps) {
  const values = [];
  for (let row = 0; row <= steps; row += 1) {
    const lat = centerLatDeg + (row / steps * 2 - 1) * halfWidthDeg;
    for (let column = 0; column <= steps; column += 1) {
      const lon = centerLonDeg + (column / steps * 2 - 1) * halfWidthDeg;
      const value = sampleAtLatLon(source, lat, lon);
      if (value !== null) values.push(value);
    }
  }
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values), samples: values.length };
}

function assertGroundTruth(source) {
  const everest = sampleWindow(source, 27.988, 86.925, 0.1, 4);
  if (everest === null || everest.max <= 7_000) {
    throw new Error(`ETOPO Everest assertion failed: expected a window maximum above 7000 m, got ${everest?.max ?? 'no data'}`);
  }

  const mariana = sampleWindow(source, 11.37, 142.59, 0.1, 4);
  if (mariana === null || mariana.min >= -10_000) {
    throw new Error(`ETOPO Mariana assertion failed: expected a window minimum below -10000 m, got ${mariana?.min ?? 'no data'}`);
  }

  // Search a fixed equatorial Brazil window for a real ocean/land sign change
  // instead of hiding a failed coastline datum behind a guessed single pixel.
  let crossing = null;
  for (let lat = -5; lat <= 5 && crossing === null; lat += 0.1) {
    let previous = sampleAtLatLon(source, lat, -55);
    for (let lon = -54.9; lon <= -45 && crossing === null; lon += 0.1) {
      const current = sampleAtLatLon(source, lat, lon);
      if (previous !== null && current !== null && ((previous < 0 && current >= 0) || (previous >= 0 && current < 0))) {
        crossing = { lat, lon, west: previous, east: current };
      }
      previous = current;
    }
  }
  if (crossing === null) throw new Error('ETOPO coastline assertion failed: no open-ocean sign crossing found in the fixed Brazil window');
  console.log(JSON.stringify({ groundTruth: { everest, mariana, coastline: crossing } }, null, 2));
}

function encodeTerrainRgb(heightM) {
  if (heightM === null) return NO_DATA_RGB;
  const encoded = Math.max(0, Math.min(16_777_214, Math.round((heightM - TERRAIN_RGB_CODEC.offsetM) / TERRAIN_RGB_CODEC.scaleM)));
  return [Math.floor(encoded / 65_536), Math.floor((encoded % 65_536) / 256), encoded % 256];
}

function tilePng(source, face, level, tileX, tileY, faceResolution) {
  const data = Buffer.alloc(TILE_SIZE * TILE_SIZE * 3);
  for (let py = 0; py < TILE_SIZE; py += 1) {
    for (let px = 0; px < TILE_SIZE; px += 1) {
      const u = (tileX * TILE_SIZE + px + 0.5) / faceResolution;
      const v = (tileY * TILE_SIZE + py + 0.5) / faceResolution;
      const [x, y, z] = spherifiedCubeDirection(face, u, v);
      const lon = Math.atan2(z, -x);
      const value = sampleSource(source, wrapUnit(lon / TAU), 0.5 - Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI);
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

async function emitLevel(source, level) {
  const faceResolution = TILE_SIZE * 2 ** level;
  const tileCount = 2 ** level;
  // Path order MUST match the manifest urlTemplate: {face}/{level}/{x}/{y}.
  let bytes = 0;
  let tileFiles = 0;
  for (let face = 0; face < 6; face += 1) {
    for (let y = 0; y < tileCount; y += 1) {
      const faceDirectory = resolve(outputDirectory, String(face), String(level));
      await mkdir(faceDirectory, { recursive: true });
      for (let x = 0; x < tileCount; x += 1) {
        const pngBytes = tilePng(source, face, level, x, y, faceResolution);
        const xDirectory = resolve(faceDirectory, String(x));
        await mkdir(xDirectory, { recursive: true });
        const outputPath = resolve(xDirectory, `${y}.png`);
        await writeFile(outputPath, pngBytes);
        bytes += pngBytes.byteLength;
        tileFiles += 1;
      }
    }
  }
  return { level, faceResolution, tileCount, tileFiles, bytes };
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

await readAndVerifySource();
const source = await decodeFloatRaster();
assertGroundTruth(source);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
const levelStats = [];
for (let level = 0; level <= CANDIDATE_MAX_LEVEL; level += 1) {
  const stats = await emitLevel(source, level);
  levelStats.push(stats);
  const totalBytes = levelStats.reduce((sum, item) => sum + item.bytes, 0);
  console.log(JSON.stringify({ level: stats.level, faceResolution: stats.faceResolution, tileFiles: stats.tileFiles, bytes: stats.bytes, cumulativeBytes: totalBytes }, null, 2));
  if (totalBytes > MAX_OUTPUT_BYTES) {
    if (level === 0) throw new Error(`Terrain base level alone exceeds the ${MAX_OUTPUT_BYTES} byte disk budget`);
    // Layout is {face}/{level}/... — dropping a level means removing that
    // level's directory under EVERY face (removing outputDirectory/<level>
    // would delete a face).
    for (let face = 0; face < 6; face += 1) {
      await rm(resolve(outputDirectory, String(face), String(level)), { recursive: true, force: true });
    }
    levelStats.pop();
    break;
  }
}

const maxLevel = levelStats.at(-1).level;
console.table(levelStats.map(({ level, faceResolution, tileFiles, bytes }) => ({ level, faceResolution, tileFiles, bytes })));
const manifest = {
  tileSize: TILE_SIZE,
  maxLevel,
  urlTemplate: '/assets/terrain/base/{face}/{level}/{x}/{y}.png',
  format: 'terrain-rgb',
  noDataRgb: NO_DATA_RGB,
  codec: TERRAIN_RGB_CODEC,
  bounds: { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 },
  sourceRaster: { width: CAPPED_SOURCE_WIDTH, height: CAPPED_SOURCE_HEIGHT, projection: 'equirectangular' },
  faceResolution: TILE_SIZE * 2 ** maxLevel,
  levels: levelStats,
  source: { url: sourceUrl, sha256: sourceSha256, nativeWidth: source.width, nativeHeight: source.height, sampleFormat: 'float32-m' },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const outputSha256 = await hashDirectory(resolve(webDirectory, 'public/assets/terrain'));
console.log(JSON.stringify({
  output: resolve(webDirectory, 'public/assets/terrain'),
  manifest: manifestPath,
  sourceSha256,
  outputSha256,
  maxLevel,
  diskBudgetBytes: MAX_OUTPUT_BYTES,
  levelStats,
}, null, 2));

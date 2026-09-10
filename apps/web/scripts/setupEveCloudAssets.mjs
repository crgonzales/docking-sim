import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(scriptDirectory, '..');
const sourceDirectory = path.join(webDirectory, 'public', 'vendor', 'earth-weather');
const outputDirectory = path.join(webDirectory, 'public', 'assets', 'clouds', 'eve');
const coverageSourcePath = path.join(sourceDirectory, 'global-coverage.png');
const provenancePath = path.join(sourceDirectory, 'provenance.json');

const GLOBAL_WIDTH = 1024;
const GLOBAL_HEIGHT = 512;
const REFERENCE_WIDTH = 128;
const REFERENCE_HEIGHT = 64;
const NOISE_SIZE = 64;
const NOISE_SEED = 0x0e7e0c10;
const NOISE_PERIOD_CELLS = 4;
const NOISE_LACUNARITY = 2;
const NOISE_PERSISTENCE = 0.5;

const REFERENCE = {
  centerLatitudeDeg: 40.5,
  centerLongitudeDeg: -75,
  latitudeExtentDeg: 2.4,
  longitudeExtentDeg: 3.2,
  zones: {
    isolatedFormation: { latitudeDeg: 40.88, longitudeDeg: -75.42, radiusDeg: 0.24 },
    brokenField: {
      minLatitudeDeg: 39.78,
      maxLatitudeDeg: 41.26,
      minLongitudeDeg: -76.34,
      maxLongitudeDeg: -73.72
    },
    deepGroup: { latitudeDeg: 40.34, longitudeDeg: -74.58, radiusDeg: 0.46 },
    clearGap: { latitudeDeg: 40.08, longitudeDeg: -75.18, radiusDeg: 0.2 }
  }
};

const clamp01 = value => Math.min(1, Math.max(0, value));
const smooth = value => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};
const wrap = (value, period) => ((value % period) + period) % period;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hash2(x, y, seed = NOISE_SEED) {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

function hash3(x, y, z, seed = NOISE_SEED) {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  value = Math.imul(value ^ Math.imul(z | 0, 1442695041) ^ seed, 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

function readCoveragePng(buffer) {
  const png = PNG.sync.read(buffer);
  if (png.width !== 2048 || png.height !== 1024) {
    throw new Error(`Expected pinned 2048x1024 global coverage, got ${png.width}x${png.height}`);
  }
  return png;
}

function downsampleCoverage(png) {
  const output = new Uint8Array(GLOBAL_WIDTH * GLOBAL_HEIGHT);
  const scaleX = png.width / GLOBAL_WIDTH;
  const scaleY = png.height / GLOBAL_HEIGHT;
  for (let y = 0; y < GLOBAL_HEIGHT; y += 1) {
    for (let x = 0; x < GLOBAL_WIDTH; x += 1) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.floor((x + 1) * scaleX);
      const y0 = Math.floor(y * scaleY);
      const y1 = Math.floor((y + 1) * scaleY);
      for (let sourceY = y0; sourceY < y1; sourceY += 1) {
        for (let sourceX = x0; sourceX < x1; sourceX += 1) {
          sum += png.data[(sourceY * png.width + sourceX) * 4];
          count += 1;
        }
      }
      output[y * GLOBAL_WIDTH + x] = Math.round(sum / count);
    }
  }
  return output;
}

function deriveTypeField(coverage) {
  const output = new Uint8Array(coverage.length);
  for (let index = 0; index < coverage.length; index += 1) {
    const x = index % GLOBAL_WIDTH;
    const y = Math.floor(index / GLOBAL_WIDTH);
    const latitude = 0.5 - (y + 0.5) / GLOBAL_HEIGHT;
    const longitude = (x + 0.5) / GLOBAL_WIDTH;
    const broadStructure = 0.5 + 0.5 * Math.sin(longitude * Math.PI * 8 + latitude * 4.5);
    const scalar = 0.08 + 0.56 * (coverage[index] / 255) + 0.26 * broadStructure +
      0.1 * hash2(x, y, NOISE_SEED ^ 0x9e3779b9);
    output[index] = Math.round(255 * clamp01(scalar));
  }
  return output;
}

function wrappedLongitude(longitudeDeg) {
  return ((longitudeDeg + 180) % 360 + 360) % 360 - 180;
}

function distanceSquared(latitudeDeg, longitudeDeg, otherLatitudeDeg, otherLongitudeDeg) {
  const longitudeDelta = wrappedLongitude(longitudeDeg - otherLongitudeDeg);
  const latitudeDelta = latitudeDeg - otherLatitudeDeg;
  return latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta;
}

function referenceField(latitudeDeg, longitudeDeg) {
  const longitude = wrappedLongitude(longitudeDeg);
  const zones = REFERENCE.zones;
  if (distanceSquared(latitudeDeg, longitude, zones.clearGap.latitudeDeg, zones.clearGap.longitudeDeg) <
      zones.clearGap.radiusDeg ** 2) {
    return [0, 0];
  }
  const isolatedDistance = Math.sqrt(distanceSquared(
    latitudeDeg,
    longitude,
    zones.isolatedFormation.latitudeDeg,
    zones.isolatedFormation.longitudeDeg
  ));
  const isolated = smooth(1 - isolatedDistance / zones.isolatedFormation.radiusDeg);
  if (isolated > 0) return [0.78 * isolated, 0.1 + 0.08 * isolated];

  const deepDistance = Math.sqrt(distanceSquared(
    latitudeDeg,
    longitude,
    zones.deepGroup.latitudeDeg,
    zones.deepGroup.longitudeDeg
  ));
  const deep = smooth(1 - deepDistance / zones.deepGroup.radiusDeg);
  if (deep > 0) return [0.7 + 0.28 * deep, 0.34 + 0.1 * deep];

  const broken = zones.brokenField;
  if (latitudeDeg >= broken.minLatitudeDeg && latitudeDeg <= broken.maxLatitudeDeg &&
      longitude >= broken.minLongitudeDeg && longitude <= broken.maxLongitudeDeg) {
    const cellX = Math.floor((longitude - broken.minLongitudeDeg) * 5);
    const cellY = Math.floor((latitudeDeg - broken.minLatitudeDeg) * 5);
    const cellNoise = hash2(cellX, cellY);
    if (hash2(cellX + 97, cellY - 31) > 0.72) return [0, 0];
    return [0.18 + 0.45 * smooth(cellNoise), 0.03 + 0.2 * cellNoise];
  }
  return [0, 0];
}

function createReferenceField() {
  const output = new Uint8Array(REFERENCE_WIDTH * REFERENCE_HEIGHT * 2);
  const minLatitude = REFERENCE.centerLatitudeDeg - REFERENCE.latitudeExtentDeg;
  const minLongitude = REFERENCE.centerLongitudeDeg - REFERENCE.longitudeExtentDeg;
  for (let y = 0; y < REFERENCE_HEIGHT; y += 1) {
    const latitude = minLatitude + (y + 0.5) / REFERENCE_HEIGHT * REFERENCE.latitudeExtentDeg * 2;
    for (let x = 0; x < REFERENCE_WIDTH; x += 1) {
      const longitude = minLongitude + (x + 0.5) / REFERENCE_WIDTH * REFERENCE.longitudeExtentDeg * 2;
      const [coverage, typeField] = referenceField(latitude, longitude);
      const index = (y * REFERENCE_WIDTH + x) * 2;
      output[index] = Math.round(255 * coverage);
      output[index + 1] = Math.round(255 * typeField);
    }
  }
  return output;
}

function fade(value) {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

const GRADIENTS = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
];

function periodicGradientPerlin(x, y, z, period, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const fz = fade(z - z0);
  let value = 0;
  for (let dz = 0; dz < 2; dz += 1) {
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        const gradientIndex = Math.min(GRADIENTS.length - 1, Math.floor(hash3(
          wrap(x0 + dx, period),
          wrap(y0 + dy, period),
          wrap(z0 + dz, period),
          seed
        ) * GRADIENTS.length));
        const gradient = GRADIENTS[gradientIndex];
        value += (
          gradient[0] * (x - x0 - dx) +
          gradient[1] * (y - y0 - dy) +
          gradient[2] * (z - z0 - dz)
        ) * weight;
      }
    }
  }
  // The selected gradients have a bounded but non-unit diagonal amplitude.
  return clamp01(0.5 + 0.2886751345948129 * value);
}

function periodicFbm(x, y, z) {
  let amplitude = 1;
  let total = 0;
  let amplitudeSum = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    // Coordinates span one texture repeat. Each octave must traverse its
    // complete lattice period within that interval, including the base octave.
    const frequency = NOISE_PERIOD_CELLS * NOISE_LACUNARITY ** octave;
    const period = frequency;
    total += periodicGradientPerlin(x * frequency, y * frequency, z * frequency, period, NOISE_SEED + octave * 1013) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= NOISE_PERSISTENCE;
  }
  return total / amplitudeSum;
}

function periodicWorley(x, y, z) {
  const cells = NOISE_PERIOD_CELLS * NOISE_LACUNARITY ** 2;
  const point = [x * cells, y * cells, z * cells];
  const cell = point.map(Math.floor);
  let nearest = Number.POSITIVE_INFINITY;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const neighbour = [cell[0] + dx, cell[1] + dy, cell[2] + dz];
        const wrappedNeighbour = neighbour.map(value => wrap(value, cells));
        const feature = [
          neighbour[0] + hash3(wrappedNeighbour[0], wrappedNeighbour[1], wrappedNeighbour[2], NOISE_SEED ^ 0x85ebca6b),
          neighbour[1] + hash3(wrappedNeighbour[1], wrappedNeighbour[2], wrappedNeighbour[0], NOISE_SEED ^ 0xc2b2ae35),
          neighbour[2] + hash3(wrappedNeighbour[2], wrappedNeighbour[0], wrappedNeighbour[1], NOISE_SEED ^ 0x27d4eb2f)
        ];
        const delta = feature.map((value, index) => {
          let result = value - point[index];
          result -= Math.round(result / cells) * cells;
          return result;
        });
        nearest = Math.min(nearest, Math.hypot(delta[0], delta[1], delta[2]));
      }
    }
  }
  return clamp01(1 - nearest / Math.sqrt(3));
}

export function samplePeriodicNoise(x, y, z) {
  const perlin = periodicFbm(x, y, z);
  const worley = periodicWorley(x, y, z);
  return [perlin, worley, clamp01(0.55 * perlin + 0.45 * worley), 0.5 * perlin + 0.5 * (1 - worley)];
}

function createPeriodicNoise() {
  const output = new Uint8Array(NOISE_SIZE ** 3 * 4);
  for (let z = 0; z < NOISE_SIZE; z += 1) {
    for (let y = 0; y < NOISE_SIZE; y += 1) {
      for (let x = 0; x < NOISE_SIZE; x += 1) {
        const position = [(x + 0.5) / NOISE_SIZE, (y + 0.5) / NOISE_SIZE, (z + 0.5) / NOISE_SIZE];
        const sample = samplePeriodicNoise(...position);
        const index = (z * NOISE_SIZE * NOISE_SIZE + y * NOISE_SIZE + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) output[index + channel] = Math.round(255 * sample[channel]);
      }
    }
  }
  return output;
}

async function main() {
  const [sourceBuffer, provenanceBuffer] = await Promise.all([
    readFile(coverageSourcePath),
    readFile(provenancePath, 'utf8')
  ]);
  const provenance = JSON.parse(provenanceBuffer);
  const sourceHash = sha256(sourceBuffer);
  if (sourceHash !== provenance.outputSha256) {
    throw new Error(`Pinned global coverage hash mismatch: ${sourceHash}`);
  }
  const png = readCoveragePng(sourceBuffer);
  const coverage = downsampleCoverage(png);
  const typeField = deriveTypeField(coverage);
  const referenceFieldBytes = createReferenceField();
  const noise = createPeriodicNoise();

  await mkdir(outputDirectory, { recursive: true });
  const assets = {
    coverage: { file: 'global-coverage-r8.bin', bytes: coverage, format: 'R8', dimensions: [GLOBAL_WIDTH, GLOBAL_HEIGHT], rowOrder: 'north-first' },
    typeField: { file: 'global-type-r8.bin', bytes: typeField, format: 'R8', dimensions: [GLOBAL_WIDTH, GLOBAL_HEIGHT], rowOrder: 'north-first' },
    referenceField: { file: 'reference-field-rg8.bin', bytes: referenceFieldBytes, format: 'RG8', dimensions: [REFERENCE_WIDTH, REFERENCE_HEIGHT], rowOrder: 'south-first' },
    noise: { file: 'periodic-noise-rgba8.bin', bytes: noise, format: 'RGBA8', dimensions: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE], rowOrder: 'not-applicable' }
  };
  const manifestAssets = {};
  for (const [name, asset] of Object.entries(assets)) {
    const fileBuffer = Buffer.from(asset.bytes);
    await writeFile(path.join(outputDirectory, asset.file), fileBuffer);
    manifestAssets[name] = {
      path: `/assets/clouds/eve/${asset.file}`,
      sha256: sha256(fileBuffer),
      bytes: fileBuffer.byteLength,
      format: asset.format,
      dimensions: asset.dimensions,
      rowOrder: asset.rowOrder
    };
  }

  const manifest = {
    schemaVersion: 1,
    generatedBy: 'apps/web/scripts/setupEveCloudAssets.mjs',
    deterministic: true,
    coordinateConvention: {
      position: 'engine ECEF metres',
      northAxisECEF: [0, 0, 1],
      uv: 'equirectangular; longitude -180 at U=0, ECEF north +Z at V=1',
      imageRows: 'global maps are north-first: reverse rows on CPU before raw texture upload with flipY=false; reference map is south-first and requires no reversal'
    },
    source: {
      path: '/vendor/earth-weather/global-coverage.png',
      provenancePath: '/vendor/earth-weather/provenance.json',
      sha256: sourceHash,
      derivation: 'global coverage is a deterministic 2x2 box average of the pinned public-domain source; typeField is a continuous scalar derived from that coverage and a fixed seed'
    },
    referenceRegion: REFERENCE,
    profiles: [
      'broken-cumulus',
      'deep-convective',
      'stratus',
      'cirrus'
    ],
    noise: {
      seed: NOISE_SEED,
      periodCells: NOISE_PERIOD_CELLS,
      lacunarity: NOISE_LACUNARITY,
      persistence: NOISE_PERSISTENCE,
      octaves: 4,
      samplePositions: 'texel centers in a unit-period cube; X fastest, then Y, then Z',
      algorithm: 'periodic seeded gradient-Perlin fBm plus periodic Worley; RGBA stores Perlin, Worley, erosion and detail'
    },
    limitations: [
      'near/far view integration uses the shared field; distant appearance has not passed visual acceptance',
      'detiling is not implemented; the periodic noise asset is the bounded first field only',
      'visual flow/advection is intentionally not implemented; visual time is a caller-owned compatibility input',
      'the opt-in EVE backend bypasses stock weather masks; default promotion awaits whole-renderer acceptance'
    ],
    assets: manifestAssets
  };
  await writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Generated EVE cloud assets in ${path.relative(webDirectory, outputDirectory)}\n`);
  for (const [name, asset] of Object.entries(manifestAssets)) process.stdout.write(`${name}: ${asset.sha256}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

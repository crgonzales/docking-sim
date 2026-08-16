import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, '..');
const cacheDirectory = resolve(scriptDirectory, '.cache');
const sourceUrl = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png';
const sourceSha256 = '4a70590d40dd7b9c69b9ab359d1dc4475ce97c1d2d13625223b248364112c699';
const sourcePath = resolve(cacheDirectory, 'gebco_08_rev_elev_21600x10800.png');
const normalPngPath = resolve(cacheDirectory, 'earth_normal_4k.png');
const outputPath = resolve(webDirectory, 'public/assets/textures/earth_normal_4k.ktx2');
const WIDTH = 4096;
const HEIGHT = 2048;
const METERS_PER_LEVEL = 19750 / 255;
const TEXEL_GROUND_DISTANCE = 2 * Math.PI * 6371000 / WIDTH;
const EXAGGERATION = 6.0;

async function downloadSource() {
  await mkdir(cacheDirectory, { recursive: true });
  let bytes;
  try {
    bytes = await readFile(sourcePath);
  } catch {
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Unable to download ${sourceUrl}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(sourcePath, bytes);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sourceSha256) {
    throw new Error(`Checksum mismatch for ${sourcePath}: expected ${sourceSha256}, got ${digest}`);
  }
  return bytes;
}

function decodeElevation(bytes) {
  const decoded = PNG.sync.read(bytes);
  const values = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const sourceY = Math.min(decoded.height - 1, Math.floor((y + 0.5) * decoded.height / HEIGHT));
    for (let x = 0; x < WIDTH; x += 1) {
      const sourceX = Math.floor((x + 0.5) * decoded.width / WIDTH) % decoded.width;
      values[y * WIDTH + x] = decoded.data[(sourceY * decoded.width + sourceX) * 4] * METERS_PER_LEVEL;
    }
  }
  return values;
}

function wrapX(x) { return (x + WIDTH) % WIDTH; }
function heightAt(values, x, y) {
  return values[Math.max(0, Math.min(HEIGHT - 1, y)) * WIDTH + wrapX(x)];
}

async function makeNormalPng(values) {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const dx = (heightAt(values, x + 1, y) - heightAt(values, x - 1, y))
        * EXAGGERATION / (2 * TEXEL_GROUND_DISTANCE);
      const dy = (heightAt(values, x, y + 1) - heightAt(values, x, y - 1))
        * EXAGGERATION / (2 * TEXEL_GROUND_DISTANCE);
      const length = Math.hypot(-dx, -dy, 1);
      const index = (y * WIDTH + x) * 4;
      png.data[index] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      png.data[index + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255);
      png.data[index + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
      png.data[index + 3] = 255;
    }
  }
  await writeFile(normalPngPath, PNG.sync.write(png));
}

await makeNormalPng(decodeElevation(await downloadSource()));
const toktx = process.env.TOKTX_BIN ?? 'toktx';
try {
  await execFileAsync(toktx, ['--t2', '--uastc', '4', '--genmipmap', '--assign_oetf', 'linear', outputPath, normalPngPath]);
} catch (error) {
  throw new Error(`Normal PNG generated at ${normalPngPath}, but ${toktx} was unavailable or failed. Set TOKTX_BIN to a KTX-Software toktx binary. ${error.message}`);
}
console.log(JSON.stringify({ output: outputPath, width: WIDTH, height: HEIGHT,
  metersPerLevel: METERS_PER_LEVEL, texelGroundDistance: TEXEL_GROUND_DISTANCE, exaggeration: EXAGGERATION }, null, 2));

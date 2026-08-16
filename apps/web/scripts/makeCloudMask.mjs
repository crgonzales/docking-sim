import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
// utif2 is CommonJS; in Node ESM its functions live on the default export —
// a namespace import yields { default: {...} } with no decode().
import UTIF from 'utif2';
import ts from 'typescript';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, '..');
const cacheDirectory = resolve(scriptDirectory, '.cache');
const outputPath = resolve(webDirectory, 'public/assets/textures/cloud_coverage_mask.png');
const sourceUrl = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif';
const sourceSha256 = 'd137775d8966ab8d443fd5126dc6e7ad72072bc1ed50555c5818d221735daf0f';
const sourcePath = resolve(cacheDirectory, 'cloud_combined_8192.tif');
const outputWidth = 512;
const outputHeight = 256;

async function importTypeScriptModule(filePath) {
  const source = await readFile(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: filePath,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

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

function sourceGrayPixels(bytes) {
  const ifds = UTIF.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (ifds.length === 0) throw new Error('The cloud TIFF has no image directory');
  UTIF.decodeImage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const width = ifds[0].width;
  const height = ifds[0].height;
  const gray = new Float32Array(width * height);
  // The GPU samples the cloud texture through SRGBColorSpace, so the shader's
  // coverage transfer function sees DECODED linear values. Decode here too or
  // the CPU placement density disagrees with the GPU gating (the same
  // coverage function fed encoded bytes accepts far more mid-gray).
  const srgbToLinear = (encoded) => (
    encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4
  );
  for (let index = 0; index < gray.length; index += 1) {
    const rgbaIndex = index * 4;
    gray[index] = 0.299 * srgbToLinear(rgba[rgbaIndex] / 255)
      + 0.587 * srgbToLinear(rgba[rgbaIndex + 1] / 255)
      + 0.114 * srgbToLinear(rgba[rgbaIndex + 2] / 255);
  }
  return { width, height, gray };
}

function sampleBilinear(source, u, v) {
  const wrappedU = ((u % 1) + 1) % 1;
  const clampedV = Math.max(0, Math.min(1, v));
  const x = wrappedU * (source.width - 1);
  const y = clampedV * (source.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % source.width;
  const y1 = Math.min(y0 + 1, source.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix, iy) => source.gray[iy * source.width + ix];
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

const skyConfig = await importTypeScriptModule(resolve(webDirectory, 'src/scene/sky/skyConfig.ts'));
const { cloudCoverageAtCpu } = skyConfig;
const source = sourceGrayPixels(await downloadSource());
const coverageData = Buffer.alloc(outputWidth * outputHeight);
for (let y = 0; y < outputHeight; y += 1) {
  for (let x = 0; x < outputWidth; x += 1) {
    const u = (x + 0.5) / outputWidth;
    const v = (y + 0.5) / outputHeight;
    const base = sampleBilinear(source, u, v);
    const detail = sampleBilinear(source, u * skyConfig.CLOUD_DECK_DETAIL_SCALE + skyConfig.CLOUD_COVERAGE_DETAIL_OFFSET[0],
      v * skyConfig.CLOUD_DECK_DETAIL_SCALE + skyConfig.CLOUD_COVERAGE_DETAIL_OFFSET[1]);
    const coverage = Math.round(cloudCoverageAtCpu(base, detail) * 255);
    coverageData[y * outputWidth + x] = coverage;
  }
}

const png = new PNG({ width: outputWidth, height: outputHeight });
png.data = coverageData;
await mkdir(dirname(outputPath), { recursive: true });
// pngjs defaults to RGBA input (4 bytes/px); with a 1-byte/px buffer it read
// only the first quarter of rows and emitted a malformed asset. Declare the
// grayscale input/output layout explicitly.
await writeFile(outputPath, PNG.sync.write(png, {
  colorType: 0,
  inputColorType: 0,
  bitDepth: 8,
  inputHasAlpha: false,
}));
console.log(JSON.stringify({ output: outputPath, width: outputWidth, height: outputHeight,
  sha256: createHash('sha256').update(await readFile(outputPath)).digest('hex') }, null, 2));

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, '..');
const sourceDirectory = resolve(webDirectory, 'src/scene/sky');
const outputDirectory = resolve(webDirectory, 'public/assets/lut');

async function importTypeScriptModule(filePath) {
  const source = await readFile(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    fileName: filePath,
  }).outputText;
  const encoded = Buffer.from(output, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

async function writeFloat32Artifact(fileName, data) {
  const outputPath = resolve(outputDirectory, fileName);
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await writeFile(outputPath, bytes);
  return {
    fileName,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const skyConfig = await importTypeScriptModule(resolve(sourceDirectory, 'skyConfig.ts'));
const atmosphereMath = await importTypeScriptModule(resolve(sourceDirectory, 'atmosphereMath.ts'));
const coefficients = skyConfig.SKY_CONFIG.atmosphere;

await mkdir(outputDirectory, { recursive: true });
const transmittance = atmosphereMath.bakeTransmittanceLut(
  coefficients,
  atmosphereMath.TRANSMITTANCE_LUT_SIZE,
);
const multipleScattering = atmosphereMath.bakeMultipleScatteringLut(
  coefficients,
  atmosphereMath.MULTIPLE_SCATTERING_LUT_SIZE,
);

const artifacts = [
  await writeFloat32Artifact('transmittance.bin', transmittance),
  await writeFloat32Artifact('multiple_scattering.bin', multipleScattering),
];

console.log(JSON.stringify({
  transmittance: atmosphereMath.TRANSMITTANCE_LUT_SIZE,
  multipleScattering: atmosphereMath.MULTIPLE_SCATTERING_LUT_SIZE,
  artifacts,
}, null, 2));

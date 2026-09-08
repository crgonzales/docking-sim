// Populate only this checkout from pinned, installed MIT library assets.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const web = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(web, 'public/vendor/takram');
const files = [];
for (const [pkg, version, folder, names] of [
  ['three-atmosphere', '0.19.1', 'atmosphere', ['transmittance.bin', 'scattering.bin', 'irradiance.bin', 'higher_order_scattering.bin']],
  ['three-clouds', '0.7.6', 'clouds', ['local_weather.png', 'turbulence.png', 'shape.bin', 'shape_detail.bin']],
]) {
  const source = path.join(web, 'node_modules/@takram', pkg);
  if (JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).version !== version) throw new Error(`Expected ${pkg}@${version}`);
  await mkdir(path.join(destination, folder), { recursive: true });
  for (const name of names) {
    const target = path.join(destination, folder, name);
    await copyFile(path.join(source, 'assets', name), target);
    files.push({ file: `${folder}/${name}`, sha256: createHash('sha256').update(await readFile(target)).digest('hex') });
  }
}
const commit = '9627216cc50057994c98a2118f3c4a23765d43b9';
for (const [file, url] of [
  ['stbn.bin', `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${commit}/packages/core/assets/stbn.bin`],
  ['LICENSE', `https://raw.githubusercontent.com/takram-design-engineering/three-geospatial/${commit}/LICENSE`],
]) {
  const response = await fetch(url); if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer()); await writeFile(path.join(destination, file), data);
  files.push({ file, url, sha256: createHash('sha256').update(data).digest('hex') });
}
await writeFile(path.join(destination, 'asset-checksums.json'), JSON.stringify(files, null, 2));
console.log(`Prepared ${files.length} pinned renderer assets in ${destination}`);

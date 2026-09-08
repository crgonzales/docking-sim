// Reuse the project's pinned NASA cloud source without the legacy cloud shader's
// contrast/detail transfer. Brightness is a static coverage proxy, not live
// meteorological density or a physically measured liquid-water field.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { PNG } from 'pngjs';
import UTIF from 'utif2';
const web = fileURLToPath(new URL('../', import.meta.url));
const sourceUrl = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif';
const sourceHash = 'd137775d8966ab8d443fd5126dc6e7ad72072bc1ed50555c5818d221735daf0f';
const cache = process.argv[2] ?? resolve(web, 'scripts/.cache/cloud_combined_8192.tif');
let bytes;
try { bytes = await readFile(cache); } catch {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`NASA cloud source: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(cache), {recursive:true}); await writeFile(cache, bytes);
}
if (createHash('sha256').update(bytes).digest('hex') !== sourceHash) throw new Error('Cloud source checksum mismatch');
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const [ifd] = UTIF.decode(buffer); UTIF.decodeImage(buffer, ifd);
const source = UTIF.toRGBA8(ifd);
const width = 2048, height = 1024, stride = ifd.width / width;
if (stride !== Math.floor(stride) || ifd.height / height !== stride) throw new Error('Unexpected source dimensions');
const pixels = Buffer.alloc(width * height);
for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
  let sum=0;
  for(let dy=0;dy<stride;dy++) for(let dx=0;dx<stride;dx++) {
    const i=((y*stride+dy)*ifd.width+x*stride+dx)*4;
    sum += (source[i]+source[i+1]+source[i+2])/3;
  }
  pixels[y*width+x]=Math.round(sum/(stride*stride));
}
const png = new PNG({width,height}); png.data=pixels;
const output=PNG.sync.write(png,{colorType:0,inputColorType:0,bitDepth:8,inputHasAlpha:false});
const folder=resolve(web,'public/vendor/earth-weather'); await mkdir(folder,{recursive:true});
await writeFile(resolve(folder,'global-coverage.png'),output);
await writeFile(resolve(folder,'provenance.json'),JSON.stringify({sourceUrl,sourceSha256:sourceHash,outputSha256:createHash('sha256').update(output).digest('hex'),width,height,license:'NASA public domain; source already documented in assets/ASSETS.md',processing:'4x4 box average of encoded grayscale brightness; treated as linear coverage proxy; north at top; longitude -180 at left. Static illustrative weather.'},null,2)+'\n');
console.log(`Prepared ${width}x${height} global cloud coverage at ${folder}`);

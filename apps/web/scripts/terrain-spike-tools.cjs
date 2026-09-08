/* In-memory TS loader for terrain-only CPU checks; no browser or dev server. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const webRequire = Module.createRequire(path.join(root, 'apps/web/package.json'));
let ts;
try { ts = webRequire('typescript'); }
catch { ts = Module.createRequire(path.resolve(root, '../apps/web/package.json'))('typescript'); }
function compile(mod, source, filename) {
  const input = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href));
  mod._compile(ts.transpileModule(input, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, filename);
}
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (mod, filename) => compile(mod, fs.readFileSync(filename, 'utf8'), filename);
function baselineModule(relative) {
  const filename = path.join(root, relative);
  const source = execFileSync('git', ['show', `HEAD:${relative}`], { cwd: root, encoding: 'utf8' });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  compile(mod, source, filename);
  return mod.exports;
}
const terrain = path.join(root, 'apps/web/src/scene/terrain');
const config = require(path.join(terrain, '../sky/skyConfig.ts'));
const quadtree = require(path.join(terrain, 'quadtree.ts'));
const heightField = require(path.join(terrain, 'heightField.ts'));
const nodes = require(path.join(terrain, 'terrainNodeSet.ts'));
const worker = require(path.join(terrain, 'terrainWorker.ts'));
const R = config.EARTH_RADIUS_M;
const position = (altitude, lat = 28.6, lon = -80.6) => heightField.directionFromLatLon(lat * Math.PI / 180, lon * Math.PI / 180).map(n => n * (R + altitude));
const selectionOptions = { projectionScalePx: 360 / Math.tan(Math.PI / 8), splitThresholdPx: 2, maxLevel: 10, maxLivePatches: 300, horizonCulling: true };
module.exports = { root, terrain, webRequire, baselineModule, config, quadtree, heightField, nodes, worker, R, position, selectionOptions };

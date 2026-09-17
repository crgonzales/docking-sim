import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import {
  ALLOWED_ORIGINS, BUNDLE_NAME, BUNDLE_SHA256_NAME, BUNDLE_SIZE_CEILING_BYTES, classifyModuleId, isNodeBuiltin, mcBuildConfig, WORKSPACE_ROOT,
} from '../../../vite.mc.config';
import { sha256Hex } from './manifest';

let outDir: string;
const moduleIds: string[] = [];

beforeAll(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnc-mc-bundle-'));
  // A real build of the real entry into a temporary directory; the game's vite.config.ts is never loaded.
  await build({ ...mcBuildConfig({ outDir, onModuleIds: (ids) => moduleIds.push(...ids) }), configFile: false, logLevel: 'silent' });
}, 120_000);

afterAll(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

describe('module origin classification', () => {
  it('allows only the mc modules, demoRun.ts, sim-core sources and Node built-ins', () => {
    const at = (relative: string) => path.join(WORKSPACE_ROOT, relative);
    expect(classifyModuleId(at('apps/web/src/gncLab/mc/cli.ts'))).toBe('allowed');
    expect(classifyModuleId(at('apps/web/src/gncLab/session/demoRun.ts'))).toBe('allowed');
    expect(classifyModuleId(at('packages/sim-core/src/sim.ts'))).toBe('allowed');
    expect(classifyModuleId(`${at('packages/sim-core/src/index.ts')}?v=1`)).toBe('allowed');
    expect(classifyModuleId('node:fs')).toBe('builtin');
    expect(classifyModuleId('fs')).toBe('builtin');
    expect(classifyModuleId('\0commonjsHelpers.js')).toBe('virtual');
    for (const forbidden of [
      at('apps/web/src/scene/Earth.tsx'),
      at('apps/web/src/scene/clouds/shaders/distantCloud.glsl'),
      at('apps/web/src/telemetry/bus.ts'),
      at('apps/web/src/gncLab/ui/BlockNode.tsx'),
      at('apps/web/src/gncLab/session/other.ts'),
      at('apps/web/node_modules/three/build/three.module.js'),
      at('node_modules/.pnpm/react@18.3.1/node_modules/react/index.js'),
      at('packages/scenario/src/director.ts'),
      '/somewhere/else/secret.env',
      '\0virtual:something',
    ]) expect(classifyModuleId(forbidden), forbidden).toBe('forbidden');
    expect(ALLOWED_ORIGINS).toHaveLength(3);
  });
});

describe('built bundle', () => {
  it('contains only allowed origins and Node built-in externals', () => {
    expect(moduleIds.length).toBeGreaterThan(20);
    const classes = moduleIds.map((id) => ({ id, origin: classifyModuleId(id) }));
    expect(classes.filter((entry) => entry.origin === 'forbidden')).toEqual([]);
    const sources = classes.filter((entry) => entry.origin === 'allowed').map((entry) => path.relative(WORKSPACE_ROOT, entry.id.split('?')[0]!));
    expect(sources).toContain('apps/web/src/gncLab/mc/cli.ts');
    expect(sources).toContain('apps/web/src/gncLab/session/demoRun.ts');
    expect(sources.some((id) => id.startsWith('packages/sim-core/src/'))).toBe(true);
    expect(sources.some((id) => /scene|telemetry|three|react|takram|\.glsl|\.tsx$/.test(id))).toBe(false);
    expect(classes.filter((entry) => entry.origin === 'builtin').every((entry) => isNodeBuiltin(entry.id))).toBe(true);
  });

  it('is one self-contained ES module under the size ceiling with import.meta.url preserved and a matching sha256 sidecar', () => {
    const files = fs.readdirSync(outDir).sort();
    expect(files).toEqual([BUNDLE_NAME, BUNDLE_SHA256_NAME]);
    const text = fs.readFileSync(path.join(outDir, BUNDLE_NAME), 'utf8');
    expect(text.length).toBeGreaterThan(50_000);
    expect(Buffer.byteLength(text)).toBeLessThan(BUNDLE_SIZE_CEILING_BYTES);
    expect(text).toContain('import.meta.url');
    expect(text).not.toMatch(/from\s+["']@docking\/sim-core["']/);
    expect(text).not.toMatch(/from\s+["']\.\.?\//);
    const imports = [...text.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => isNodeBuiltin(specifier))).toBe(true);
    expect(text).toContain('gnc-mc-worker');
    const sidecar = fs.readFileSync(path.join(outDir, BUNDLE_SHA256_NAME), 'utf8');
    expect(sidecar).toBe(`${sha256Hex(fs.readFileSync(path.join(outDir, BUNDLE_NAME)))}  ${BUNDLE_NAME}\n`);
  });
});

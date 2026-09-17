/**
 * Dedicated Vite build for the headless GNC Monte Carlo CLI (F_0.19.0 B5).
 *
 * `pnpm --dir apps/web exec vite build --config vite.mc.config.ts` bundles
 * `src/gncLab/mc/cli.ts` into one Node ES module, `dist/gnc-mc/gnc-mc.mjs`,
 * with the workspace `@docking/sim-core` inlined, Node built-ins external,
 * no minification, and `import.meta.url` preserved (the CLI uses it as its own
 * worker-thread script and as the `verify-bundle` default). A module-graph
 * guard fails the build if anything outside the allow-list is bundled, and a
 * `gnc-mc.sha256` sidecar is written next to the bundle.
 *
 * This config never loads the game's `vite.config.ts` and only empties its own
 * `dist/gnc-mc` output directory.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type UserConfig } from 'vite';

export const WEB_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(WEB_ROOT, '..', '..');
export const BUNDLE_NAME = 'gnc-mc.mjs';
export const BUNDLE_SHA256_NAME = 'gnc-mc.sha256';
export const DEFAULT_OUT_DIR = 'dist/gnc-mc';
/** Plan §8: expected well under 1 MB. */
export const BUNDLE_SIZE_CEILING_BYTES = 1_000_000;

/** Workspace-relative origins that may enter the bundle. Everything else is rejected by resolved id. */
export const ALLOWED_ORIGINS = [
  'apps/web/src/gncLab/mc/',
  'apps/web/src/gncLab/session/demoRun.ts',
  'packages/sim-core/src/',
] as const;

export type ModuleOrigin = 'builtin' | 'allowed' | 'virtual' | 'forbidden';

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export function isNodeBuiltin(id: string): boolean {
  return BUILTINS.has(id);
}

/** Classify a Rollup module id by where it resolved from. */
export function classifyModuleId(id: string, workspaceRoot = WORKSPACE_ROOT): ModuleOrigin {
  if (isNodeBuiltin(id)) return 'builtin';
  if (id.startsWith('\0')) {
    // Vite/Rollup helper modules (e.g. commonjs helpers) are not source; anything else virtual is suspect.
    return id.startsWith('\0commonjsHelpers') || id.startsWith('\0vite/') ? 'virtual' : 'forbidden';
  }
  const clean = id.split('?')[0]!;
  const relative = path.relative(workspaceRoot, clean).split(path.sep).join('/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'forbidden';
  if (relative.includes('node_modules/')) return 'forbidden';
  return ALLOWED_ORIGINS.some((origin) => relative === origin || relative.startsWith(origin)) ? 'allowed' : 'forbidden';
}

export interface GuardOptions {
  /** Receives every module id in the final graph (externals included), for tests. */
  onModuleIds?: (ids: string[]) => void;
  workspaceRoot?: string;
}

/** Fails the build on forbidden origins or a multi-file output; writes the SHA-256 sidecar. */
export function moduleGraphGuard(options: GuardOptions = {}): Plugin {
  return {
    name: 'gnc-mc-module-graph-guard',
    generateBundle(_outputOptions, bundle) {
      const ids = [...this.getModuleIds()];
      options.onModuleIds?.(ids);
      const forbidden = ids.filter((id) => classifyModuleId(id, options.workspaceRoot) === 'forbidden');
      if (forbidden.length > 0) this.error(`forbidden module origins in the gnc-mc bundle:\n${forbidden.join('\n')}`);
      const externals = ids.filter((id) => this.getModuleInfo(id)?.isExternal);
      const badExternal = externals.filter((id) => !isNodeBuiltin(id));
      if (badExternal.length > 0) this.error(`non-builtin externals would leave the bundle unresolved:\n${badExternal.join('\n')}`);
      const files = Object.keys(bundle);
      if (files.length !== 1 || files[0] !== BUNDLE_NAME) this.error(`expected exactly one output file ${BUNDLE_NAME}, got ${files.join(', ')}`);
    },
    writeBundle(outputOptions) {
      const dir = outputOptions.dir ?? path.dirname(outputOptions.file ?? '');
      const bundlePath = path.join(dir, BUNDLE_NAME);
      const bytes = fs.readFileSync(bundlePath);
      if (bytes.length > BUNDLE_SIZE_CEILING_BYTES) throw new Error(`${BUNDLE_NAME} is ${bytes.length} bytes, above the ${BUNDLE_SIZE_CEILING_BYTES} byte ceiling`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(path.join(dir, BUNDLE_SHA256_NAME), `${sha256}  ${BUNDLE_NAME}\n`);
    },
  };
}

export interface McBuildOptions extends GuardOptions {
  outDir?: string;
}

/** The complete build configuration; the default export wraps it for `vite build --config`. */
export function mcBuildConfig(options: McBuildOptions = {}): UserConfig {
  return {
    root: WEB_ROOT,
    // Never copy the game's public/ assets (renderer textures, vendor LUTs) next to the bundle.
    publicDir: false,
    logLevel: 'warn',
    plugins: [moduleGraphGuard(options)],
    ssr: { noExternal: ['@docking/sim-core'], target: 'node' },
    build: {
      ssr: 'src/gncLab/mc/cli.ts',
      outDir: options.outDir ?? DEFAULT_OUT_DIR,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      sourcemap: false,
      rollupOptions: {
        external: (id) => isNodeBuiltin(id),
        output: { format: 'es', entryFileNames: BUNDLE_NAME, inlineDynamicImports: true },
      },
    },
  };
}

export default defineConfig(mcBuildConfig());

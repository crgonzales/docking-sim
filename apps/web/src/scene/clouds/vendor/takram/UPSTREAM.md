# Pinned Takram clouds source

This directory contains the source closure copied byte-for-byte from the installed
`@takram/three-clouds@0.7.6` package before the local Phase 1 backend seam was
applied. The package is pinned by the existing pnpm lockfile integrity recorded in
`manifest.json`; no network fetch was used. The original upstream SHA-256 inventory
remains in the manifest; intentional fork edits and added files are recorded under
`fork`.

The local public entry is `index.ts`. It exposes the upstream Three.js runtime
barrel from `src/index.ts`. R3F components, tests, generated build/types output,
package documentation, and the package's demo/runtime assets are intentionally
outside this source closure. Existing public Takram assets retain their separate
provenance under `apps/web/public/vendor/takram/`.

## Upstream diff check

Run this from the repository root after installing the pinned workspace:

```sh
diff -ruN \
  --exclude=CloudLayers.test.ts --exclude=r3f \
  apps/web/node_modules/@takram/three-clouds/src \
  apps/web/src/scene/clouds/vendor/takram/src
```

Exit code `0` was required for the pre-fork copy. The manifest records the same
corrected exclusions and exact SHA-256 for every included upstream source file. The
current fork is expected to differ only at the paths listed under `fork`; update
that record before making any additional vendor change.

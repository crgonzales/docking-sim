# Code Review: v0.15.1 — Under the Hood

**Review date**: 2026-09-17
**Verdict**: APPROVED for the bounded orbital cloud hotfix.

## Scope

Four files change from the released renderer: `VolumetricCloudSystem.ts`,
`CloudsResolveMaterial.ts`, `cloudsResolve.frag` and `clouds.frag`.
The replacement renderer's incompatible work-in-progress buffers and shaders
are excluded. The hotfix uses the existing canonical column atlas; no independent
shell, density field, cloud quality increase or ray-count increase is introduced.

## Independent review

A focused independent Codex review verified base/candidate/patch hashes and
examined scene clipping, current-ray endpoint validity, history rejection,
bounded cubic filtering and stationary accumulation. No blocking correctness
finding remained. This was a manual independent TRIP hotfix review, not a
self-approval or a synthesized full-feature review loop. Claude Opus critiques
of earlier candidates informed the foreground and history corrections.

The reviewer approved source correctness only; actual built GPU and visual
acceptance were performed separately by the author and parent. The frozen patch
SHA-256 is `dbfa5591a92bbfeae0685455a64cfe1ac0269497b565eacf6eeccd1ef9e005cd`.

## Verification

Production build and 285-module released-source audit pass. TypeScript is
byte-identical to the prior candidate's passing type check and 89 affected
unit tests. The final shader correction passes 15 GPU fixtures for valid
history, scene endpoints, foreground/background and nonfinite rejection.

The parent inspected actual built static and moving mission images. Coarse
cloud fringes and moving blockiness are reduced. Camera stop/start and moving
foreground captures exercise disocclusion. Low-altitude smoke captures retain
the near-volume path. Detailed metrics, measured GPU overhead and remaining
visual limitations are recorded in `../2-changelog/w7_v0.15.1.md`.

## Observations

- Newly revealed clouds still need subsequent samples to sharpen. This review
  does not claim all temporal artifacts or ordinary antialiasing issues are gone.
- Whole-scene GPU time rises by about 1.0–1.4 ms stationary and 2.5–3.1 ms moving
  in the measured Mac fixture. Moving p95 slightly exceeds 16.67 ms.
- Early evidence with incorrect served-build identity or incomplete orbital
  readiness was excluded from acceptance. Final captures verify the loaded
  build and shader identities with a fully ready orbital representation.
- The replacement port must meet its own object-edge and transition acceptance;
  this hotfix is not automatically compatible with its new buffer layout.

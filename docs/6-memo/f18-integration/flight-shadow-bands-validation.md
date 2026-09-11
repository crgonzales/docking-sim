# Aircraft shadow bands — 2026-09-11

Follow-up to checkpoint `8e930fb`, in the integrated checkout on port 5175.
One existing game tab was used throughout.

## Cause and correction

The report contained both self-shadow stripes and coarse shadow edges. Disabling
only the local directional shadow map removed them while retaining cloud lighting.
The source GLB marks its materials double-sided. Casting the curved hull's front
skin produced visible corrugations on that same surface. Its owned material now
uses back-face shadow casting; visible faces, shared source assets, and the
casting behavior of thin wings, rudders, doors and gear remain unchanged.

The fixed 1.5cm normal offset was also too small for the PCF footprint of the old
1024 map over 110m. The offset now follows 0.8 shadow texels, bounded to 10cm for
hardware-clamped maps. Balanced uses 2048 (5.37cm texels, 4.30cm offset); High uses
4096 (2.69cm texels, 2.15cm offset). The original depth bias and PCFSoft filtering
remain. Graphics changes update the projection and dispose the old shadow map.

The 110m coverage is preserved. An experimental 44m footprint sharpened the
plane, but independent review found that chase view places it outside those
bounds; that experiment was rejected. Broad back-face casting and wider PCF
filter experiments were also removed. No new shadow pass or custom shadow shader
was introduced.

## Evidence

Files below are local ignored artifacts under `.evidence.local/`:

- Hull before/after: `flight-base-1789109371717` / `flight-base-1789109527889`.
  Both have exactly equal camera, aircraft and environment-clock snapshots.
  Rear-fuselage corrugations disappear; the wing and ground shadows remain.
- Balanced wing stripes before/after the bias correction:
  `flight-base-1789109554400` / `flight-base-1789109806048`, also with equal
  camera, aircraft and environment-clock snapshots.
- Final Balanced close ground view: `flight-base-1789109968829`.
- High grazing morning and noon checks: `flight-base-1789110088608` /
  `flight-base-1789110101562`. The gear still meets its ground shadow.
- Boarding/chase, exit to first person, and paused preset switches were checked.
  The aircraft retains its full projected shadow in chase view.

DEV evidence now records the actual map bounds/bias and cumulative consecutive
running-frame time. Paused warmup and pause duration are excluded; subtract two
running samples to obtain FPS. The temporary always-visible evidence panel is
removed from the ordinary game before completion.

## Cost and limits

At 981×1115 CSS pixels on the M3, final Balanced (DPR1, 2048 shadows) recorded
3663 frames / 77.6492s = **47.17FPS**, using samples `1789109989677` /
`1789110067326`. The High 4096-map comparison recorded 1350 frames / 43.2392s =
**31.22FPS**, versus 36.19FPS with its previous 2048 map at the same scene DPR1.5.
That comparison preceded the final hull-culling/offset adjustment. Final High
recorded **3071 frames / 93.7228s = 32.77FPS**, at 1471×1672 drawing pixels,
using samples `1789110135983` / `1789110229705`. The camera position remained
unchanged during each measured interval. No build/test job ran during these
performance samples.

Each preset's shadow-map pixel allocation is four times its previous size.
High remains opt-in. These are single-view measurements, not a guarantee for
every weather condition or display. Shadow resolution remains finite; close
grazing edges can still reveal small pixel steps, especially in Balanced.
The imported model's texture/geometry detail and existing cloud grain are unchanged.

## Final gate

The complete workspace build passes, as do all 11 affected tests across lighting,
graphics and owned model materials. The existing fixture test now explicitly
preserves its legacy 1024 setting; material assertions verify that the hull's
shadow culling does not alter shared source paint or thin-part casting.

The focused review caught the rejected narrow-footprint regression. The final
Codex CLI review returned **APPROVED**, with no findings (thread
`01a08f49-174d-7d32-be1a-1d77dbef97c6`;
`docs/3-code-review/CR_wa_flight-shadow-bands.md`). No new console errors were
observed. The ordinary game URL is restored, paused on High, with one tab open.

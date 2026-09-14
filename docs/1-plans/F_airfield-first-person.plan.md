# Airfield and first-person runway start

## Overview

Make ordinary `?mode=flight` open on foot beside a parked F/A-18C at an original KSC-inspired base. Add a marked runway, taxiway/apron, hangars, control tower, and separate landing pad in the existing Earth/EVE scene. Preserve explicit airborne starts and the cloud-base development fixture. This iteration supports walking and boarding a parked aircraft; ground roll, takeoff, and landing-contact dynamics remain a separate feature.

## Architecture

- Integrate the reviewed first-person prototype from `docking-sim-character`, preserving its worktree. Keep one camera, Canvas, composer, and live terrain source in FlightMode.
- Site at the surveyed 7°N, 0.02°E prototype fixture. Deck top is 105m MSL. The complete footprint N±850m/E[-450,+100]m was surveyed through runtime `height()` including all 12 procedural octaves at raster LOD0–3. Independent continuous height bound is 103.124525m; after a 0.1m chart allowance, the deck retains 1.775475m clearance. Actual `buildPatchGeometry` triangles at geometry LOD0–16 clipped to the footprint peak at 97.861428m. Evidence: `.evidence.local/airfield-terrain-survey.json`. Foundation extends 35m down into the existing terrain; no planet renderer change.
- `airfieldSite.ts` is the shared site definition: datum, dimensions, building footprints, runway start, and analytic ground support. Local axes are east/up/south in metres, right handed. A plane tangent to the site datum is intersected with the radial direction used by flightWorldFrame; rendered pavement and foot/aircraft heights must agree including curvature across the runway. Movement rejects unsupported perimeter and solid building footprints; arbitrary building interiors and aircraft body collision are outside this iteration.
- `Airfield.tsx` renders that same site datum with camera-relative WorldFrame coordinates, updating after the flight camera rebase. Use standard materials under existing lighting, simple original geometry, shared/instanced repetitive markings/lights. No extra renderer, real-time shadow pass, network model, or texture dependency.
- CharacterSession remains the vehicle/on-foot coordinator, with injectable ground sampler and fixture anchor/view configuration. Default UI route selects base/on foot. Route precedence is defined below and tested. Programmatic CharacterSession construction with no explicit start/search retains its AIRBORNE default.

| Query (first matching rule) | Start | Character |
| --- | --- | --- |
| DEV + flightProbe=1 + flightFixture=cloud-base | Captured airborne fixture | Disabled, even if ground/character query conflicts |
| character=0 | Legacy airborne | Disabled, even if start=ground |
| start=airborne + character=1 | Airborne | Enabled |
| start=airborne | Legacy airborne | Disabled |
| Otherwise, including character=1&start=ground | Base/on foot | Enabled |

- Use the shared airfield surface for parked initialization immediately, independent of asynchronous DEM arrival. Start 11.5m right of the aircraft with an 80° vertical first-person field of view, looking toward it; aircraft gear deployed. Keep flight simulation frozen while parked. A FlightSession park boundary must reconcile private controls/trim and cancel exercises.
- Hide/gate flight exercise reset and flight controls during parked/on-foot ownership. Character pause, blur, reset, pointer-lock release and board/exit transitions clear inputs. Keep c160798 paused resize warmup, cloud grain fix and passive post-composer evidence capture.
- Keep the 50km equatorial airborne simulation unchanged: base location is a presentation/on-foot start, not a new global physics origin. No claim that parked boarding enables flight.

## Files and batches

1. Shared `apps/web/src/airfield/airfieldSite.ts`, `Airfield.tsx`; base geometry and support contract are one unit. Bounded independent delegate owns only this directory, excluding parent-authored tests.
2. Import reviewed `apps/web/src/character/*`, `hornetPresentation.ts`, and mandatory parked HornetModel changes revealing deployed gear while preserving airborne exclusions. Reconcile FlightMode with current exercise/evidence/resize code, FlightSession park boundary, route default and site support. Existing prototype tests retained and updated for intentional route/start changes.
3. Parent integration review, missing behavioral tests, visual adjustment, docs and validation. Preserve existing branches/source index and shared asset symlinks.

## Technical and performance constraints

Use existing flightWorldFrame/WorldFrame; no new geodetic sign convention. Keep all world positioning Float64 until camera-relative render conversion. Bounded geometry and no per-frame asset construction or terrain fetching. Reuse single game tab on 5175; never touch reserved 5173. Leave paused when testing is idle.

## Test impact

- Surface agreement at spawn, runway ends, pad/apron, and off-site/solid footprints; world-frame transform round trips and radial/tangent height.
- Default and explicit route precedence, immediate base start with missing terrain, gear clearance, initial view, walk/run/diagonal distance, perimeter blocking, no step through buildings, board/exit distance checks, input release and parked flight immobility.
- Retain relevant FlightSession/exercise/fixture/frame/Hornet and character tests. One final workspace build plus affected tests; no renderer shader changes planned.
- One-tab browser walkthrough: first-person spawn shows Hornet on pavement, runway markings and base; walk/look, board/exit, equip, reset/pause; chase/nose parked view and explicit airborne/cloud fixture remain usable. Screenshot actual rendered output, check new console errors. Do not claim full landing solver or photographic terrain.

## Documentation impact

Update ARCHI with site/character ownership and surface contract, a short base controls/limitations memo, and review/validation records. Preserve character prototype provenance and model attribution. Save a development checkpoint after validation; no release/push.

## To-do

- [x] Survey site and review plan.
- [x] Build shared airfield definition and scene geometry.
- [x] Integrate character, parked presentation, input ownership and default runway start.
- [x] Verify behavior and visuals in one game tab; fix findings.
- [x] Pass build, affected tests, independent code review; document and checkpoint.

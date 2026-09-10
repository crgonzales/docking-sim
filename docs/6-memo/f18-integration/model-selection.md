# F/A-18 Hornet asset recommendation

**Integration update — 2026-09-10:** the user signed in and the official 2K GLB was downloaded and integrated. Retained asset: `apps/web/public/assets/models/f18/hornet-source.glb`, 4,756,768 bytes, SHA-256 `5c44e8edc7492185fe84f41810b9568e08008392725bbf0100baad251b684a07`. Its embedded credits match the creator and CC BY 4.0 listing. Runtime adapter preserves the original file, maps source +Z/+Y/+X (forward/up/left) to body forward/right/down, scales length to 17.06 m, and hides gear/doors/hook/stores for airborne flight. The textured aircraft was inspected in the integrated EVE scene. Control surfaces remain static; the converted asset contains two color maps, with no added normal/AO maps. Current distributed attribution is in `apps/web/public/assets/ASSETS.md`.

The research record below describes the earlier unauthenticated investigation; its download and geometry unknowns were subsequently resolved as stated above.

Research date: 2026-09-10. Scope: external-model research only; no game tabs, servers, source checkout changes, purchases, or authentication bypasses.

## Recommendation and current availability

Choose **McDonnell Douglas F/A-18C Hornet by Rhine_Lab_Muelsyse** for the browser simulator.

Official creator listing: https://sketchfab.com/3d-models/mcdonnell-douglas-fa-18c-hornet-c68c8417c8e84864b2a5e0c35c178fd9

Public metadata: https://api.sketchfab.com/v3/models/c68c8417c8e84864b2a5e0c35c178fd9

The public listing and API explicitly identify CC BY 4.0 and downloadable status. The listing's Model Information panel explicitly lists converted GLB, glTF, USDZ, and original FBX. Therefore the model does not inherently require an FBX-to-GLB conversion.

**Actual access test:** clicking the official Download 3D Model button opened a Sketchfab login dialog in the current unauthenticated research session. No model binary was downloaded, and the converted GLB has not been inspected or validated. This folder contains research/provenance evidence, not an integration-ready aircraft. A parent follow-up can use the normal authenticated download flow or a file supplied through that flow. No credentials were accessed and no account was created.

## Verified technical details

| Property | Verified value |
| --- | --- |
| Triangles | 9,935 (API); 9.9k rounded on listing |
| Vertices | 6,113 (API) |
| Materials | 3 |
| Processed textures | 2 |
| UV layers | Yes |
| PBR | No, per Model Information |
| Animations | 0 |
| Rigged geometries | No |
| Morph geometries | 0 |
| Formats offered | FBX, converted glTF, GLB, USDZ |
| Displayed download size | 22 MB; this is the listing's total, not a measured GLB size |
| Original mesh | FA-18C.fbx, displayed 732 kB |
| Airframe texture set | texture.png, texture_ao.png, texture_nm.png; all 3072 × 2048 |
| Tank texture set | Tank_F18.png, Tank_F18_ao.png, Tank_F18_nm.png; all 256 × 256 |
| Processed texture list | Only Tank_F18 and texture are listed |

Visual inspection of the creator's published preview shows a recognizable legacy Hornet silhouette, gray Navy/Marine markings, painted panel details, transparent canopy, twin tails, intakes, landing gear, pylons, and a centerline tank. The preview is gear-down. It appears well suited to an external/chase view; cockpit close-up quality is unverified. Recommendation is based on the preview plus metadata, not on loading the downloaded geometry.

The source archive includes normal and AO maps, but the public processed-texture list only shows the two color maps, and PBR is marked No. Do not assume those additional maps are connected in the converted GLB. Independent object names, mesh separation, gear pivots, control-surface pivots, units, forward axis, transparency behavior, and exact GLB size remain unverified behind download access.

## Integration/conversion follow-up

1. Obtain the offered GLB through Sketchfab's normal signed-in Download flow; keep the original FBX/source archive as well if material repair is needed.
2. Inspect GLB meshes/materials before integration. Check whether the landing gear, canopy, flaps, rudders, elevators, hook, and tank are separate objects. No animation clips or rig are advertised; gear/control motion must be authored if required.
3. Check the airframe/tank color textures and canopy alpha. If normal/AO maps are absent from the conversion, import the original FBX in Blender and connect the supplied maps to a glTF-compatible material. A suitable starting point for painted panels is nonmetallic material with moderate roughness, adjusted by visual inspection; the archive does not advertise a complete metallic/roughness texture set.
4. Preserve the modest triangle count initially. Measure actual GLB transfer size and GPU texture cost; the 22 MB listing size should not be treated as the runtime payload. Reduce texture resolution or add supported texture compression only if needed, preserving the 3:2 airframe atlas aspect ratio. Material count is not a measured draw-call count.
5. Set simulator scale, origin, and forward/up alignment after measuring the asset. If conversion is necessary, use Blender's glTF 2.0 Binary (.glb) exporter with embedded textures and validate the export. Test transparency, normals, and the gear-up silhouette before integrating.
6. Preserve source, author, license link, and actual modifications in distributed credits/third-party notices. The file ATTRIBUTION-TEMPLATE.md contains a reusable credit and a separate instruction for adding only changes actually performed.

Official conversion references:
- Blender import/export support: https://www.blender.org/features/pipeline/
- Blender glTF material/export documentation: https://docs.blender.org/manual/en/4.0/addons/import_export/scene_gltf2.html
- Sketchfab authenticated Download API documentation: https://sketchfab.com/developers/download-api/downloading-models

## License and attribution

License: Creative Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/ . It permits redistribution and adaptation, including commercial use, with attribution, a license link, and an indication of changes. Credit must not imply creator endorsement. Preserve any additional notices supplied in the downloaded archive. The license assignment was verified in the creator's listing/API; the inaccessible archive has not been checked for additional credits.

## Other candidates assessed

| Candidate | Findings | Decision |
| --- | --- | --- |
| waelXcm, F/A18 C Hornet – fighter jet | 32,754 triangles; 16,731 vertices; CC BY 4.0; 7 materials; 13 processed textures; PBR metalness; 1K and 2K texture sets; FBX and Blender source; converted GLB offered; displayed 43 MB download; no rig/animation; NoAI flag | Runner-up if richer PBR materials matter. Same site authentication limitation. Preview shows open canopy and gear down; not a ready animated player aircraft. |
| HeriFajar, F/A-18 Hornet Low Poly | 31,122 triangles; CC BY 4.0; creator explicitly says minimal textures, no cockpit, and possible dimensional inaccuracies | Weaker fit than the recommended textured 9.9k model. |
| cs09736, Low Poly F/A-18 Hornet | 6,852 triangles; CC BY-SA 4.0; Blender-built with stores | Additional share-alike obligations; not preferable to CC BY candidate. |
| Aidan McTaggart, Blue Angels FA/18 | 27,547 triangles; CC BY 4.0 | Different livery, higher count; no advantage established. |
| ChrisKuhn, High Poly Hornet (BlendSwap) | CC-BY label; two-seat B variant; 25.2 MB Blender 2.6x/Cycles archive; creator says cockpit is blocked out, some preview decals were added after rendering, textures need unpacking | Less suitable for immediate browser integration. Official download page also says Sign in to download. |
| FGMEMBERS-NONGPL/FA-18 | LICENSE states the original author has not declared a license; repository imposes temporary BY-NC-SA. AC3D model and simulation components exist. | Excluded. The repository statement does not establish the original rights holder's reuse grant. No model assets downloaded or re-imported. |
| NASA | No F-18/Hornet entry found in the complete main NASA-3D-Resources tree checked or the Airborne Science model catalog | No concrete NASA download to recommend. This is a scoped catalog finding, not a claim that NASA has never made an F-18 asset. |

Runner-up listing: https://sketchfab.com/3d-models/fa18-c-hornet-fighter-jet-78b3c419829b489e9c6789d3b4bb41f9
HeriFajar: https://sketchfab.com/3d-models/fa-18-hornet-low-poly-25a2485d6eb4428f89c014e03fb42047
cs09736: https://sketchfab.com/3d-models/low-poly-fa-18-hornet-9b48c88e91ba40fc8f518b616f44f714
Aidan McTaggart: https://sketchfab.com/3d-models/blue-angels-fa18-af0fde87125844bb947322526a9611fe
ChrisKuhn: https://blendswap.com/blend/8636
BlendSwap access check: https://blendswap.com/blend/8636/download
FlightGear license: https://github.com/FGMEMBERS-NONGPL/FA-18/blob/6d6af48e848085d93d8206d1f2b2400b27dd2db1/LICENSE
NASA main catalog: https://science.nasa.gov/3d-resources/
NASA repository: https://github.com/nasa/NASA-3D-Resources
NASA tree checked: 11ebb4ee043715aefbba6aeec8a61746fad67fa7 (API says truncated=false)
NASA aircraft catalog: https://airbornescience.nasa.gov/3d-models/src/models.json

## Limited additional lead, not a recommendation

NPS Savage hosts an older F/A-18 Blue Angel model by Etsuko Lippi (created 2001) with an explicit Web3D/BSD-style license reference and direct X3D source. Its top-level XML contains 18 Inline nodes plus an external prototype; this is not a self-contained ready GLB. No full dependency package was downloaded, converted, or visually validated. Research stopped once the strongest relevant option and access limitation were concrete. Do not treat this lead as a verified quality substitute.

- https://savage.nps.edu/Savage/AircraftFixedWing/F18BlueAngelUnitedStates/BlueAngelF18StandAloneIndex.html
- https://savage.nps.edu/Savage/license.html

## Evidence saved

provenance/*.json contains date-stamped Sketchfab API responses plus the NASA inventories. provenance/flightgear-LICENSE.txt preserves the exact exclusion evidence. provenance/verified-listing-details.json records public UI observations for the two strongest options. SHA256SUMS.txt permits integrity checks of the saved evidence files.

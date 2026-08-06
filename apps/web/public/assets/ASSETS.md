# Asset Provenance

| File | Source | License | Processing |
| --- | --- | --- | --- |
| `textures/earth_day.jpg` | three.js `examples/textures/planets/earth_atmos_2048.jpg` (NASA Blue Marble derivative) | Public domain imagery (NASA); distributed in three.js (MIT) | none (2048×1024) |
| `textures/earth_night.png` | three.js `examples/textures/planets/earth_lights_2048.png` (NASA Earth at Night / Black Marble derivative) | Public domain imagery (NASA); distributed in three.js (MIT) | renamed only (2048×1024) |
| `textures/earth_spec.jpg` | three.js `examples/textures/planets/earth_specular_2048.jpg` (NASA water mask derivative) | Public domain imagery (NASA); distributed in three.js (MIT) | none (2048×1024) |
| `hdri/starmap.jpg` | ESO — The Milky Way panorama (`eso0932a`), https://www.eso.org/public/images/eso0932a/ | CC BY 4.0 — credit: ESO/S. Brunier | downscaled to 4096×2048 (Lanczos, q88) per the ≤4k GPU budget; LDR is sufficient because star bloom is excluded by design (background intensity clamped below the bloom threshold) |
| `models/` (empty) | — | — | **Placeholder**: Phase 1 ships stylized primitive spacecraft built in code (`src/scene/Spacecraft.tsx`), per the plan's documented fallback. Normalized NASA 3D Resources `.glb` models (meter scale, COM pivot, docking axis ±ŷ) are a planned follow-up; drop `target.glb` / `chaser.glb` here and flip `USE_GLTF_MODELS` in `Spacecraft.tsx`. |

Conventions for future model drops: meter scale, pivot at vehicle COM, target docking port faces −ŷ, chaser docking axis +ŷ; record the normalization transform (scale, rotation, pivot offset) in this table.

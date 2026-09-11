import { Material, Mesh, MeshStandardMaterial, Texture, type Group } from 'three';
import type { FlightCloudLightingBridge } from '../scene/flightCloudLighting';
import { isExcludedHornetPart } from './hornetPresentation';

const CANOPY_GLASS = /canopy_glass|windshield|windshied/i;
const PAINTED_EXTERIOR = /^(?:hull_|wing_|Airbrake_|Leftrudder_brake_|Rudder(?:Left|Right)_|aileron_|canopy_|(?:left|right)_(?:Elevator|flap)_|gear.*_door|nose_gear_door)/i;

export interface ClonedHornet {
  readonly model: Group;
  readonly materials: readonly Material[];
  readonly textures: readonly Texture[];
  dispose(): void;
}

/** Own texture handles once per source texture, retaining cached images and geometry. */
export function cloneHornet(scene: Group, parked: boolean, cloudLighting?: FlightCloudLightingBridge): ClonedHornet {
  const model = scene.clone(true) as Group;
  const materials: Material[] = [];
  const textureClones = new Map<Texture, Texture>();
  const cloudReleases: (() => void)[] = [];
  model.traverse((object) => {
    if (isExcludedHornetPart(object.name, parked)) {
      object.visible = false;
      return;
    }
    if (!(object instanceof Mesh)) return;
    const canopyGlass = CANOPY_GLASS.test(object.name);
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const clonedMaterials = sourceMaterials.map((sourceMaterial: Material) => {
      const material = sourceMaterial.clone();
      materials.push(material);
      for (const [key, value] of Object.entries(material)) {
        if (!(value instanceof Texture)) continue;
        let texture = textureClones.get(value);
        if (!texture) {
          texture = value.clone();
          textureClones.set(value, texture);
        }
        (material as unknown as Record<string, unknown>)[key] = texture;
      }
      if (material instanceof MeshStandardMaterial) {
        // The source factors are ~0.94 hull / ~0.965 glass. Set the intended
        // finish explicitly; retain all maps, color, alpha and metalness.
        if (canopyGlass) {
          material.roughness = 0.2;
          material.depthWrite = false;
        } else if (PAINTED_EXTERIOR.test(object.name)) {
          material.roughness = 0.7;
        }
        if (cloudLighting) cloudReleases.push(cloudLighting.registerMaterial(material));
      }
      return material;
    });
    object.material = Array.isArray(object.material) ? clonedMaterials : clonedMaterials[0]!;
    // Blended glass cannot cast an opaque depth shadow; preserve local casters.
    object.castShadow = !canopyGlass && clonedMaterials.every((material) => !material.transparent && material.opacity >= 1);
    object.receiveShadow = true;
  });
  const textures = [...textureClones.values()];
  let disposed = false;
  return { model, materials, textures, dispose() {
    if (disposed) return;
    disposed = true;
    cloudReleases.forEach((release) => release());
    materials.forEach((material) => material.dispose());
    // Texture.dispose releases GPU handles. Shared ImageBitmaps stay cache-owned.
    textures.forEach((texture) => texture.dispose());
  } };
}

export function resolveHornetAnisotropy(requested: number, maximum: number): number {
  const limit = Number.isFinite(maximum) ? Math.max(1, Math.floor(maximum)) : 1;
  return Math.max(1, Math.min(limit, Math.floor(Number.isFinite(requested) ? requested : 8)));
}

import { Material } from 'three';

/** Transparent emission/decals do not supply an opaque surface to these passes. */
export function hasOpaqueSurface(material: Material): boolean {
  return material.visible && !(material.transparent && !material.depthWrite);
}

/** Own replacements, never source assets. One entry per source keeps material
 * groups independent; disposal also releases terrain uniform closures/listeners.
 */
export class SurfaceMaterialCache<T extends Material> {
  #entries = new Map<Material, { material: T; release: () => void }>();
  constructor(private readonly create: (source: Material) => T) {}

  get(source: Material): T {
    let entry = this.#entries.get(source);
    if (!entry) {
      const material = this.create(source);
      const release = () => {
        source.removeEventListener('dispose', release);
        this.#entries.delete(source);
        material.dispose();
      };
      entry = { material, release };
      this.#entries.set(source, entry);
      source.addEventListener('dispose', release);
    }
    const material = entry.material;
    if (material.side !== source.side) {
      material.side = source.side;
      material.needsUpdate = true;
    }
    if ('flatShading' in material) {
      const flatShading = 'flatShading' in source && source.flatShading === true;
      if (material.flatShading !== flatShading) {
        material.flatShading = flatShading;
        material.needsUpdate = true;
      }
    }
    // Preserve invisible/nonopaque slots inside otherwise opaque material arrays.
    material.visible = hasOpaqueSurface(source);
    return material;
  }

  dispose(): void {
    for (const entry of this.#entries.values()) entry.release();
  }
}

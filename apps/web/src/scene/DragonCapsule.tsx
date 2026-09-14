import { useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { Mesh, MeshStandardMaterial, Quaternion } from 'three';
import { CREW_DRAGON_SCALE, CREW_DRAGON_OFFSET_Y } from '@docking/sim-core';
import { DragonLivery } from './DragonLivery';

export const DRAGON_MODEL_URL = '/assets/models/dragon/crew-dragon.glb';
// Source capsule diameter is 0.4 units; register the exposed docking face to
// the sim's fixed +Y contact datum. The trunk remains a separate source part.

export function DragonCapsule() {
  const { scene, animations } = useGLTF(DRAGON_MODEL_URL);
  const resources = useMemo(() => {
    const model = scene.clone(true);
    const materials = new Map<MeshStandardMaterial, MeshStandardMaterial>();
    model.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const clone = (source: MeshStandardMaterial) => {
        let material = materials.get(source);
        if (!material) {
          material = source.clone();
          material.metalness = Math.min(material.metalness, 0.35);
          material.roughness = Math.max(material.roughness, 0.32);
          if (material.name === 'BIALY.001') material.color.set('#dce2e4');
          materials.set(source, material);
        }
        return material;
      };
      object.material = Array.isArray(object.material) ? object.material.map(clone) : clone(object.material);
    });
    // Use just the authored cover-open track. Playing the full presentation
    // animation would also detach the trunk during a docking run.
    const nose = model.getObjectByName('Circle001_2');
    const track = animations[0]?.tracks.find(t => t.name === 'Circle001_2.quaternion');
    if (nose && track) {
      const sample = track.createInterpolant().evaluate(7);
      nose.quaternion.copy(new Quaternion().fromArray(sample));
    }
    model.scale.setScalar(CREW_DRAGON_SCALE);
    model.position.y = CREW_DRAGON_OFFSET_Y;
    return { model, materials };
  }, [scene, animations]);
  useEffect(() => () => { resources.materials.forEach(material => material.dispose()); }, [resources]);
  return (
    <>
      <primitive object={resources.model} dispose={null} />
      <DragonLivery model={resources.model} />
    </>
  );
}

import { useEffect } from 'react';
import { useLoader, useThree } from '@react-three/fiber';
import {
  Euler, FrontSide, Group, Mesh, MeshStandardMaterial, SRGBColorSpace,
  TextureLoader, Vector3, type Object3D, type Texture,
} from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

const LOGO_URL = '/assets/textures/lucky_marlin_logo.png';

/** Project in Object_9's source coordinates, then parent to that same hull.
 * This keeps the paint registered through model scaling and spacecraft motion.
 * The 2:1 projectors cover Y=0.28..0.36, Z=-0.08..0.08 on the +/-X sides:
 * above the windows/hardware and below the cover, entirely on white shell.
 */
export function createDragonLivery(hull: Mesh, sourceTexture: Texture, anisotropy: number) {
  const texture = sourceTexture.clone();
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;

  const shellMaterial = hull.material as MeshStandardMaterial;
  const material = new MeshStandardMaterial({
    name: 'Lucky Marlin capsule paint',
    map: texture,
    roughness: shellMaterial.roughness,
    metalness: shellMaterial.metalness,
    side: FrontSide,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const group = new Group();
  group.name = 'Lucky Marlin livery';
  // Borrow only geometry/material; the detached projector target has identity
  // matrixWorld, so DecalGeometry cannot bake in the moving parent's pose.
  const target = new Mesh(hull.geometry, hull.material);
  const geometries = [-1, 1].map(sign => {
    const geometry = new DecalGeometry(
      target,
      new Vector3(sign * 0.135, 0.32, 0),
      new Euler(0, sign * Math.PI / 2, 0),
      new Vector3(0.16, 0.08, 0.12),
    );
    const mesh = new Mesh(geometry, material);
    mesh.name = `Lucky Marlin ${sign > 0 ? '+' : '-'}X`;
    mesh.renderOrder = 1;
    mesh.receiveShadow = hull.receiveShadow;
    group.add(mesh);
    return geometry;
  });

  return {
    group,
    dispose() {
      group.removeFromParent();
      geometries.forEach(geometry => geometry.dispose());
      material.dispose();
      texture.dispose();
    },
  };
}

export function DragonLivery({ model }: { model: Object3D }) {
  const sourceTexture = useLoader(TextureLoader, LOGO_URL);
  const anisotropy = useThree(state => Math.min(8, state.gl.capabilities.getMaxAnisotropy()));
  useEffect(() => {
    // This particular primitive is the capsule's white shell. Selecting the
    // material globally would also paint the trunk, cover and small hardware.
    const hull = model.getObjectByName('Object_9');
    if (!(hull instanceof Mesh) || !(hull.material instanceof MeshStandardMaterial)
      || hull.material.name !== 'BIALY.001') return;
    const livery = createDragonLivery(hull, sourceTexture, anisotropy);
    hull.add(livery.group);
    return () => livery.dispose();
  }, [model, sourceTexture, anisotropy]);
  return null;
}

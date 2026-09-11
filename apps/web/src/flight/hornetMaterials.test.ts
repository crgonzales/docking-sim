import { describe, expect, it } from 'vitest';
import { BackSide, BoxGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, Texture } from 'three';
import { cloneHornet, resolveHornetAnisotropy } from './hornetMaterials';

describe('owned Hornet materials', () => {
  it('changes paint and glass finishes while preserving cached source assets and gear', () => {
    const image = { width: 2, height: 2 };
    const texture = new Texture();
    texture.image = image;
    const paint = new MeshStandardMaterial({ roughness: 0.94, metalness: 0, map: texture, side: DoubleSide });
    const glass = new MeshStandardMaterial({ roughness: 0.965, opacity: 0.15, transparent: true });
    const geometry = new BoxGeometry();
    const source = new Group();
    for (const [name, material] of [['hull_Material', paint], ['gear_l_Material', paint], ['canopy_glass', glass], ['wing_l_Material', paint]] as const) {
      const mesh = new Mesh(geometry, material); mesh.name = name; source.add(mesh);
    }
    const owned = cloneHornet(source, true);
    const [hull, gear, canopy, wing] = owned.model.children as Mesh<BoxGeometry, MeshStandardMaterial>[];
    expect(hull.material.roughness).toBe(0.7);
    expect(gear.material.roughness).toBe(0.94);
    expect(canopy.material.roughness).toBe(0.2);
    expect(canopy.material.opacity).toBe(0.15);
    expect(canopy.material.depthWrite).toBe(false);
    expect(canopy.castShadow).toBe(false);
    expect(hull.castShadow).toBe(true);
    expect(hull.material.shadowSide).toBe(BackSide);
    expect(hull.material.side).toBe(DoubleSide);
    // Shared source paint must not propagate the hull's culling to thin parts.
    expect([paint.shadowSide, gear.material.shadowSide, wing.material.shadowSide]).toEqual([null, null, null]);
    expect(hull.geometry).toBe(geometry);
    expect(hull.material.map).toBe(gear.material.map);
    expect(hull.material.map).not.toBe(texture);
    expect(hull.material.map!.image).toBe(image);
    hull.material.map!.anisotropy = 8;
    expect(texture.anisotropy).toBe(1);
    expect(paint.roughness).toBe(0.94);
    expect(glass.roughness).toBe(0.965);
    expect(glass.depthWrite).toBe(true);
    let sourceDisposals = 0, ownedDisposals = 0;
    texture.addEventListener('dispose', () => sourceDisposals++);
    paint.addEventListener('dispose', () => sourceDisposals++);
    geometry.addEventListener('dispose', () => sourceDisposals++);
    owned.textures.forEach((map) => map.addEventListener('dispose', () => ownedDisposals++));
    owned.dispose(); owned.dispose();
    expect(ownedDisposals).toBe(1);
    expect(sourceDisposals).toBe(0);
    texture.dispose(); paint.dispose(); glass.dispose(); geometry.dispose();
  });

  it('bounds filtering to actual hardware without accepting invalid values', () => {
    expect(resolveHornetAnisotropy(16, 8)).toBe(8);
    expect(resolveHornetAnisotropy(0, 16)).toBe(1);
    expect(resolveHornetAnisotropy(Infinity, 4)).toBe(4);
    expect(resolveHornetAnisotropy(8, NaN)).toBe(1);
  });
});

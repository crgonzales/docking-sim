import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BoxGeometry, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Object3D, Quaternion, StaticDrawUsage, Vector3 } from 'three';
import type { WorldFrame } from '../scene/worldFrame';
import { AIRFIELD_BASIS, AIRFIELD_DATUM_WORLD } from './airfieldSite';
import { AIRFIELD_BOXES, type AirfieldBox, type AirfieldMaterialName } from './airfieldGeometry';
import { applyAirfieldSurface } from './airfieldSurface';

const MATERIAL_OPTIONS: Record<AirfieldMaterialName, ConstructorParameters<typeof MeshStandardMaterial>[0]> = {
  infield: { color: '#536047', roughness: 0.98, metalness: 0 },
  foundation: { color: '#776c5b', roughness: 0.92, metalness: 0.02 },
  pavement: { color: '#3f4647', roughness: 0.94, metalness: 0.02 },
  shoulder: { color: '#5b6260', roughness: 0.96, metalness: 0.01 },
  building: { color: '#9a9b94', roughness: 0.78, metalness: 0.08 },
  roof: { color: '#737b78', roughness: 0.86, metalness: 0.08 },
  glass: { color: '#142d35', roughness: 0.22, metalness: 0.3 },
  detail: { color: '#303938', roughness: 0.7, metalness: 0.22 },
  whiteMarking: { color: '#d7d6c8', roughness: 0.88, metalness: 0 },
  yellowMarking: { color: '#d49b20', roughness: 0.82, metalness: 0 },
  edgeLight: {
    color: '#b8d8d2',
    emissive: '#7fe3d4',
    emissiveIntensity: 2.2,
    roughness: 0.35,
    metalness: 0.05,
  },
};

function createBoxBatch() {
  const grouped = new Map<AirfieldMaterialName, AirfieldBox[]>();
  for (const spec of AIRFIELD_BOXES) {
    const list = grouped.get(spec.material);
    if (list) list.push(spec);
    else grouped.set(spec.material, [spec]);
  }
  const geometry = new BoxGeometry(1, 1, 1);
  const group = new Group();
  const materials: MeshStandardMaterial[] = [];
  let edgeLightMaterial: MeshStandardMaterial | undefined;
  const meshes: InstancedMesh[] = [];
  const dummy = new Object3D();
  for (const [name, items] of grouped) {
    const material = new MeshStandardMaterial(MATERIAL_OPTIONS[name]);
    applyAirfieldSurface(material, name);
    if (name === 'edgeLight') edgeLightMaterial = material;
    const mesh = new InstancedMesh(geometry, material, items.length);
    // The parent owns the one local directional shadow map. Flat deck/paint
    // only receive it; opaque buildings, trim and perimeter geometry cast it.
    mesh.castShadow = name === 'building' || name === 'roof' || name === 'detail';
    mesh.receiveShadow = name !== 'edgeLight';
    mesh.instanceMatrix.setUsage(StaticDrawUsage);
    items.forEach((item, index) => {
      dummy.position.fromArray(item.position);
      dummy.rotation.set(...(item.rotation ?? [0, 0, 0]));
      dummy.scale.fromArray(item.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
    materials.push(material);
    meshes.push(mesh);
  }
  return {
    group,
    edgeLightMaterial,
    dispose() {
      group.removeFromParent();
      meshes.forEach((mesh) => mesh.dispose());
      geometry.dispose();
      materials.forEach((material) => material.dispose());
      group.clear();
    },
  };
}

const SITE_QUATERNION = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(
  new Vector3().fromArray(AIRFIELD_BASIS.east),
  new Vector3().fromArray(AIRFIELD_BASIS.up),
  new Vector3().fromArray(AIRFIELD_BASIS.south),
));

export interface AirfieldProps {
  readonly worldFrame: WorldFrame;
  /** 0 = night, 1 = day; absent/nonfinite keeps the legacy 2.2 intensity. */
  readonly daylightRef?: RefObject<number>;
}

function edgeLightIntensity(daylight: number | null | undefined): number {
  if (daylight == null || !Number.isFinite(daylight)) return 2.2;
  const day = Math.max(0, Math.min(1, daylight));
  return 2.2 + (0.12 - 2.2) * day * day * (3 - 2 * day);
}

/** One static instanced base, repositioned after the flight camera's -2 rebase. */
export function Airfield({ worldFrame, daylightRef }: AirfieldProps) {
  const root = useRef<Group>(null);
  const edgeLight = useRef<MeshStandardMaterial>();
  const invalidate = useThree((state) => state.invalidate);
  const initialPosition = useMemo(() => worldFrame.toRender(AIRFIELD_DATUM_WORLD), [worldFrame]);
  const metersToRender = useMemo(() => worldFrame.relativeToRender([1, 0, 0], [0, 0, 0])[0], [worldFrame]);

  // Allocate inside setup: StrictMode's setup/cleanup/setup gets fresh resources,
  // and an abandoned React render allocates no GPU objects.
  useLayoutEffect(() => {
    const batch = createBoxBatch();
    edgeLight.current = batch.edgeLightMaterial;
    root.current!.add(batch.group);
    invalidate();
    return () => {
      edgeLight.current = undefined;
      batch.dispose();
    };
  }, [invalidate]);

  useLayoutEffect(() => {
    if (edgeLight.current) edgeLight.current.emissiveIntensity = edgeLightIntensity(daylightRef?.current);
    invalidate();
  }, [daylightRef, invalidate]);

  useFrame(() => {
    root.current?.position.fromArray(worldFrame.toRender(AIRFIELD_DATUM_WORLD));
    if (edgeLight.current) edgeLight.current.emissiveIntensity = edgeLightIntensity(daylightRef?.current);
  }, -1);

  return <group ref={root} position={initialPosition} quaternion={SITE_QUATERNION} scale={metersToRender} />;
}

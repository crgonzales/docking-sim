import { afterEach, describe, expect, it, vi } from 'vitest';
import { NormalPass, Selection } from 'postprocessing';
import {
  BufferGeometry, Color, Float32BufferAttribute, Line, Mesh, MeshBasicMaterial,
  MeshNormalMaterial, PerspectiveCamera, Points, Scene, ShaderChunk, ShaderLib,
  Sprite, Vector3, WebGLRenderTarget, type ColorRepresentation, type WebGLRenderer,
} from 'three';
import { maskSurfaceNormalShader, SurfaceNormalPass } from './librarySurfaceNormalPass';

const disposables: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T { disposables.push(value); return value; }
afterEach(() => { disposables.splice(0).forEach(value => value.dispose()); vi.restoreAllMocks(); });
const compact = (source: string) => source.replace(/\s+/g, '');
const normalShader = () => ({ vertexShader: ShaderLib.normal.vertexShader, fragmentShader: ShaderLib.normal.fragmentShader });

function fixture() {
  const scene = new Scene(), camera = new PerspectiveCamera();
  const material = own(new MeshBasicMaterial()), other = own(new MeshBasicMaterial());
  const geometry = own(new BufferGeometry());
  const waterGeometry = own(new BufferGeometry());
  waterGeometry.setAttribute('waterMask', new Float32BufferAttribute([0, 1, 1], 1));
  const solid = new Mesh(geometry, material), arrayMesh = new Mesh(geometry, [material, other]);
  const water = new Mesh(waterGeometry, material), water2 = new Mesh(waterGeometry, other);
  const hidden = new Mesh(geometry, material); hidden.visible = false;
  const line = new Line(geometry), points = new Points(geometry), sprite = new Sprite();
  for (const drawable of [line, points, sprite]) {
    for (const value of Array.isArray(drawable.material) ? drawable.material : [drawable.material]) own(value);
  }
  line.layers.set(3); points.layers.set(4); sprite.layers.set(5);
  const child = new Mesh(geometry, other); line.add(child);
  scene.add(solid, arrayMesh, water, water2, hidden, line, points, sprite);
  scene.background = new Color(0x123456);
  scene.overrideMaterial = other;
  camera.layers.enable(7);
  return { scene, camera, solid, arrayMesh, water, water2, hidden, line, points, sprite, child };
}

// Exercise the installed NormalPass, RenderPass and ClearPass without a GPU.
function rendererStub() {
  const color = new Color(0x234567);
  let alpha = 0.3;
  const stub = {
    shadowMap: { enabled: true, autoUpdate: true },
    getClearColor: vi.fn((target: Color) => target.copy(color)),
    getClearAlpha: vi.fn(() => alpha),
    setClearColor: vi.fn((value: ColorRepresentation, valueAlpha?: number) => {
      color.set(value); if (valueAlpha !== undefined) alpha = valueAlpha;
    }),
    setClearAlpha: vi.fn((value: number) => { alpha = value; }),
    setRenderTarget: vi.fn(), clear: vi.fn(), render: vi.fn((_scene: Scene, _camera: PerspectiveCamera) => {}),
  };
  return { stub, renderer: stub as unknown as WebGLRenderer, color };
}

describe('surface normal coverage pass', () => {
  it('renders once with two cached materials, preserves the stock target/clear, and restores originals', () => {
    const f = fixture(), { stub, renderer } = rendererStub();
    const pass = own(new SurfaceNormalPass(f.scene, f.camera, { resolutionScale: 0.5 }));
    const stock = own(new NormalPass(f.scene, f.camera));
    const originals = [f.solid.material, f.arrayMesh.material, f.water.material, f.water2.material];
    const nonMeshMaterials = [f.line.material, f.points.material, f.sprite.material];
    const background = f.scene.background, override = f.scene.overrideMaterial;
    const layers = [f.line.layers.mask, f.points.layers.mask, f.sprite.layers.mask];
    let normal!: MeshNormalMaterial, masked!: MeshNormalMaterial;
    stub.render.mockImplementation((scene, camera) => {
      expect(scene).toBe(f.scene); expect(camera).toBe(f.camera);
      expect(scene.overrideMaterial).toBeNull(); expect(scene.background).toBeNull();
      expect(pass.renderPass.overrideMaterial).toBeNull();
      expect(stub.shadowMap).toEqual({ enabled: false, autoUpdate: false });
      expect(f.solid.material).toBeInstanceOf(MeshNormalMaterial);
      expect(f.arrayMesh.material).toBe(f.solid.material);
      expect(f.child.material).toBe(f.solid.material);
      expect(f.water.material).toBeInstanceOf(MeshNormalMaterial);
      expect(f.water2.material).toBe(f.water.material);
      expect(f.water.material).not.toBe(f.solid.material);
      expect(f.hidden.material).toBe(originals[0]);
      expect([f.line.material, f.points.material, f.sprite.material]).toEqual(nonMeshMaterials);
      expect([f.line.layers.mask, f.points.layers.mask, f.sprite.layers.mask]).toEqual([0, 0, 0]);
      expect(f.line.visible).toBe(true); // Its child remains eligible for rendering.
      if (normal) { expect(f.solid.material).toBe(normal); expect(f.water.material).toBe(masked); }
      normal = f.solid.material as unknown as MeshNormalMaterial;
      masked = f.water.material as unknown as MeshNormalMaterial;
    });
    const stockRenderPass = (stock as unknown as { renderPass: SurfaceNormalPass['renderPass'] }).renderPass;
    expect(pass.renderPass.clearPass.overrideClearColor).toEqual(stockRenderPass.clearPass.overrideClearColor);
    expect(pass.renderPass.clearPass.overrideClearAlpha).toBe(stockRenderPass.clearPass.overrideClearAlpha);
    pass.setSize(200, 100);
    const texture = pass.texture;
    expect([texture.image.width, texture.image.height]).toEqual([100, 50]);
    for (let frame = 0; frame < 3; frame++) {
      pass.render(renderer, null, null);
      expect(pass.texture).toBe(texture);
      [f.solid, f.arrayMesh, f.water, f.water2].forEach((mesh, i) => expect(mesh.material).toBe(originals[i]));
      expect(f.scene.background).toBe(background); expect(f.scene.overrideMaterial).toBe(override);
      expect([f.line.layers.mask, f.points.layers.mask, f.sprite.layers.mask]).toEqual(layers);
    }
    expect(stub.render).toHaveBeenCalledTimes(3); expect(stub.clear).toHaveBeenCalledTimes(3);
    expect(stub.setRenderTarget.mock.calls.every(([target]) => target.texture === texture)).toBe(true);
    expect(normal.version).toBe(0); expect(masked.version).toBe(0);
    const shader = normalShader();
    masked.onBeforeCompile(shader as Parameters<MeshNormalMaterial['onBeforeCompile']>[0], renderer);
    expect(shader.fragmentShader).toContain('if (vSurfaceWaterMask < 0.5) discard;');
    expect(masked.customProgramCacheKey()).not.toBe(normal.customProgramCacheKey());
  });

  it.each(['traversal', 'clear', 'draw'])('restores materials and render state after a %s error, then recovers', failure => {
    const f = fixture(), { stub, renderer, color } = rendererStub();
    const pass = own(new SurfaceNormalPass(f.scene, f.camera));
    pass.renderPass.selection = new Selection([f.solid], 9);
    const meshes = [f.solid, f.arrayMesh, f.water, f.water2, f.child];
    const originals = meshes.map(mesh => mesh.material);
    const background = f.scene.background, override = f.scene.overrideMaterial;
    const cameraMask = f.camera.layers.mask, lineMask = f.line.layers.mask, clearColor = color.clone();
    const fail = () => { throw new Error('render failed'); };
    if (failure === 'traversal') vi.spyOn(f.water.geometry, 'hasAttribute').mockImplementationOnce(fail);
    if (failure === 'clear') stub.clear.mockImplementationOnce(fail);
    if (failure === 'draw') stub.render.mockImplementationOnce(fail);
    expect(() => pass.render(renderer, null, null)).toThrow('render failed');
    meshes.forEach((mesh, i) => expect(mesh.material).toBe(originals[i]));
    expect(f.scene.background).toBe(background); expect(f.scene.overrideMaterial).toBe(override);
    expect(f.camera.layers.mask).toBe(cameraMask); expect(f.line.layers.mask).toBe(lineMask);
    expect(stub.shadowMap).toEqual({ enabled: true, autoUpdate: true });
    expect(color).toEqual(clearColor); expect(stub.getClearAlpha()).toBe(0.3);
    expect(() => pass.render(renderer, null, null)).not.toThrow();
    meshes.forEach((mesh, i) => expect(mesh.material).toBe(originals[i]));
  });

  it('follows mainScene/mainCamera changes and disposes only owned materials and the stock target', () => {
    const previous = fixture(), next = fixture(), { stub, renderer } = rendererStub();
    const target = new WebGLRenderTarget(1, 1);
    const targetDispose = vi.spyOn(target, 'dispose');
    const pass = own(new SurfaceNormalPass(previous.scene, previous.camera, { renderTarget: target }));
    const original = next.water.material, previousOriginal = previous.water.material;
    const originalDispose = vi.spyOn(original, 'dispose');
    let normal!: MeshNormalMaterial, masked!: MeshNormalMaterial;
    stub.render.mockImplementation((scene, camera) => {
      expect(scene).toBe(next.scene); expect(camera).toBe(next.camera);
      expect(previous.water.material).toBe(previousOriginal);
      normal = next.solid.material as unknown as MeshNormalMaterial;
      masked = next.water.material as unknown as MeshNormalMaterial;
    });
    pass.mainScene = next.scene; pass.mainCamera = next.camera;
    pass.render(renderer, null, null);
    const normalDispose = vi.spyOn(normal, 'dispose'), maskedDispose = vi.spyOn(masked, 'dispose');
    pass.dispose(); pass.dispose();
    expect(normalDispose).toHaveBeenCalledTimes(1); expect(maskedDispose).toHaveBeenCalledTimes(1);
    expect(targetDispose).toHaveBeenCalledTimes(1); expect(originalDispose).not.toHaveBeenCalled();
    expect(next.water.material).toBe(original);
  });
});

describe('water mask adapter against the installed Three normal shader', () => {
  it('keeps interpolated coverage, built-in view-normal normalization/packing, and log depth unchanged', () => {
    const shader = normalShader(); maskSurfaceNormalShader(shader);
    expect(shader.vertexShader).toContain('attribute float waterMask;\nvarying float vSurfaceWaterMask;');
    expect(shader.vertexShader).toContain('vSurfaceWaterMask = waterMask;');
    expect(shader.fragmentShader).toContain('varying float vSurfaceWaterMask;');
    expect(shader.fragmentShader).not.toContain('flat ');
    expect(shader.fragmentShader.indexOf('if (vSurfaceWaterMask < 0.5) discard;'))
      .toBeLessThan(shader.fragmentShader.indexOf('#include <logdepthbuf_fragment>'));
    expect(shader.vertexShader.replace('\nattribute float waterMask;\nvarying float vSurfaceWaterMask;', '')
      .replace('\nvSurfaceWaterMask = waterMask;', '')).toBe(ShaderLib.normal.vertexShader);
    expect(shader.fragmentShader.replace('\nvarying float vSurfaceWaterMask;', '')
      .replace('\nif (vSurfaceWaterMask < 0.5) discard;', '')).toBe(ShaderLib.normal.fragmentShader);
    expect(compact(ShaderChunk.defaultnormal_vertex)).toContain('transformedNormal=normalMatrix*transformedNormal;');
    expect(compact(ShaderChunk.normal_fragment_begin)).toContain('vec3normal=normalize(vNormal);');
    expect(compact(ShaderChunk.packing)).toContain('returnnormalize(normal)*0.5+0.5;');
    expect(compact(shader.fragmentShader)).toContain('gl_FragColor=vec4(packNormalToRGB(normal),diffuseColor.a);');
    expect(compact(ShaderChunk.logdepthbuf_fragment)).toContain('log2(vFragDepth)*logDepthBufFC*0.5');
    // CPU oracle for the retained packing ABI, including non-unit geometric normals.
    for (const values of [[0, 0, 4], [-2, 3, 1], [0.5265, 0.7660, 0.3687]]) {
      const normal = new Vector3(...values).normalize();
      const packed = normal.clone().multiplyScalar(0.5).addScalar(0.5);
      const decoded = packed.multiplyScalar(2).subScalar(1);
      expect(decoded.toArray().every(Number.isFinite)).toBe(true);
      expect(decoded.length()).toBeCloseTo(1, 12); expect(decoded.distanceTo(normal)).toBeLessThan(1e-12);
    }
    const discard = shader.fragmentShader.match(/if \((vSurfaceWaterMask < 0\.5)\) discard;/)![1];
    const covered = (a: number, b: number, t: number) => !Function('vSurfaceWaterMask', `return ${discard}`)(a * (1 - t) + b * t);
    expect([0, 0.49, 0.5, 0.51, 1].map(t => covered(0, 1, t))).toEqual([false, false, true, true, true]);
  });

  it.each(['vertexShader', 'fragmentShader'] as const)('rejects changed %s seams without partially patching', field => {
    const shader = normalShader();
    shader[field] = '';
    const before = { ...shader };
    expect(() => maskSurfaceNormalShader(shader)).toThrow('Pinned Three normal shader changed');
    expect(shader).toEqual(before);
    const duplicate = normalShader(); duplicate[field] += duplicate[field];
    expect(() => maskSurfaceNormalShader(duplicate)).toThrow('Pinned Three normal shader changed');
  });
});

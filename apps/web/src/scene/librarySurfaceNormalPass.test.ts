import { afterEach, describe, expect, it, vi } from 'vitest';
import { NormalPass, Selection } from 'postprocessing';
import {
  BackSide, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, FrontSide, Line, Mesh, MeshBasicMaterial,
  MeshNormalMaterial, PerspectiveCamera, Points, Scene, ShaderChunk, ShaderLib, ShaderMaterial,
  Sprite, Texture, Uniform, Vector3, WebGLRenderTarget, type ColorRepresentation, type Material, type WebGLRenderer,
} from 'three';
import { maskSurfaceNormalShader, SurfaceNormalPass } from './librarySurfaceNormalPass';
import { createTerrainSurfaceNoise, createTerrainSurfaceUniforms, type TerrainSurfaceNoiseResource } from './terrain/terrainSurface';

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
  const terrainGeometry = own(new BufferGeometry());
  terrainGeometry.setAttribute('terrainWaterMask', new Float32BufferAttribute([0, 1, 1], 1));
  const terrain = new Mesh<BufferGeometry, Material>(terrainGeometry, material);
  const solid = new Mesh(geometry, material), arrayMesh = new Mesh(geometry, [material, other]);
  const water = new Mesh(waterGeometry, material), water2 = new Mesh(waterGeometry, other);
  const hidden = new Mesh(geometry, material); hidden.visible = false;
  const line = new Line(geometry), points = new Points(geometry), sprite = new Sprite();
  for (const drawable of [line, points, sprite]) {
    for (const value of Array.isArray(drawable.material) ? drawable.material : [drawable.material]) own(value);
  }
  line.layers.set(3); points.layers.set(4); sprite.layers.set(5);
  const child = new Mesh(geometry, other); line.add(child);
  scene.add(solid, arrayMesh, water, water2, terrain, hidden, line, points, sprite);
  scene.background = new Color(0x123456);
  scene.overrideMaterial = other;
  camera.layers.enable(7);
  return { scene, camera, solid, arrayMesh, water, water2, terrain, hidden, line, points, sprite, child };
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

function terrainSource(resource: TerrainSurfaceNoiseResource, patchCenterM: [number, number, number]) {
  return own(new ShaderMaterial({ uniforms: {
    ...createTerrainSurfaceUniforms(resource, 6_371_000, { patchCenterM }),
    dayMap: new Uniform(own(new Texture())),
    planetCenter: new Uniform(new Vector3(-1000, -2000, -3000)),
    terrainSurfaceMetersPerUnit: new Uniform(1),
  } }));
}

function compileNormal(material: MeshNormalMaterial, renderer: WebGLRenderer) {
  const shader = { ...normalShader(), uniforms: {} as ShaderMaterial['uniforms'] };
  material.onBeforeCompile(shader as Parameters<MeshNormalMaterial['onBeforeCompile']>[0], renderer);
  return shader;
}

describe('surface normal coverage pass', () => {
  it.each([false, true])('preserves per-group sidedness and visibility (water=%s), reuses materials, and restores arrays', water => {
    const f = fixture(), { stub, renderer } = rendererStub();
    const sources = [FrontSide, BackSide, DoubleSide].map(side => own(new MeshBasicMaterial({ side })));
    sources.push(own(new MeshBasicMaterial({ transparent: true, depthWrite: false })),
      own(new MeshBasicMaterial({ visible: false })));
    const geometry = water ? f.water.geometry : f.solid.geometry;
    const mesh = new Mesh(geometry, sources); f.scene.add(mesh);
    const groups = geometry.groups;
    const pass = own(new SurfaceNormalPass(f.scene, f.camera));
    let cached: MeshNormalMaterial[] = [];
    stub.render.mockImplementation(() => {
      const active = mesh.material as unknown as MeshNormalMaterial[];
      expect(Array.isArray(active)).toBe(true);
      expect(active.map(m => m.side)).toEqual(sources.map(m => m.side));
      expect(active.map(m => m.visible)).toEqual([true, true, true, false, false]);
      expect(active.every(m => m instanceof MeshNormalMaterial)).toBe(true);
      if (cached.length) active.forEach((m, i) => expect(m).toBe(cached[i]));
      cached = active;
      expect(geometry.groups).toBe(groups);
    });
    pass.render(renderer, null, null);
    expect(mesh.material).toBe(sources);
    const version = cached[0].version;
    sources[0].side = DoubleSide;
    pass.render(renderer, null, null);
    expect(cached[0].version).toBe(version + 1);
    pass.render(renderer, null, null);
    expect(cached[0].version).toBe(version + 1);
    stub.render.mockImplementationOnce(() => { throw new Error('group draw failed'); });
    expect(() => pass.render(renderer, null, null)).toThrow('group draw failed');
    expect(mesh.material).toBe(sources);
    const dispose = cached.map(m => vi.spyOn(m, 'dispose'));
    const sourceDispose = sources.map(m => vi.spyOn(m, 'dispose'));
    pass.dispose(); pass.dispose();
    dispose.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
    sourceDispose.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it('does not turn alpha-only plume volumes into solid surfaces, including on render failure', () => {
    const f = fixture(), { stub, renderer } = rendererStub();
    const material = own(new ShaderMaterial({ transparent: true, depthWrite: false }));
    const plume = new Mesh(f.solid.geometry, material);
    plume.layers.enable(3); const mask = plume.layers.mask;
    const child = new Mesh(f.solid.geometry, f.solid.material); plume.add(child); f.scene.add(plume);
    const pass = own(new SurfaceNormalPass(f.scene, f.camera));
    stub.render.mockImplementationOnce(() => {
      expect(plume.layers.mask).toBe(0);
      expect(plume.material).toBe(material);
      expect(child.layers.mask).toBe(1);
      expect(child.material).toBeInstanceOf(MeshNormalMaterial);
      throw new Error('draw failed');
    });
    expect(() => pass.render(renderer, null, null)).toThrow('draw failed');
    expect(plume.layers.mask).toBe(mask); expect(plume.material).toBe(material);
    expect(() => pass.render(renderer, null, null)).not.toThrow();
    expect(plume.layers.mask).toBe(mask);
  });
  it('renders once with two cached materials, preserves the stock target/clear, and restores originals', () => {
    const f = fixture(), { stub, renderer } = rendererStub();
    const pass = own(new SurfaceNormalPass(f.scene, f.camera, { resolutionScale: 0.5 }));
    const stock = own(new NormalPass(f.scene, f.camera));
    const originals = [f.solid.material, f.arrayMesh.material, f.water.material, f.water2.material, f.terrain.material];
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
      expect(f.arrayMesh.material).toEqual([f.solid.material, f.child.material]);
      // Unified terrain must retain land AND water normals. Selecting the
      // water-only material here silently erases every dry part of the tile.
      expect(f.terrain.material).toBe(f.solid.material);
      expect(f.water.material).toBeInstanceOf(MeshNormalMaterial);
      expect(f.water2.material).toBeInstanceOf(MeshNormalMaterial);
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
      [f.solid, f.arrayMesh, f.water, f.water2, f.terrain].forEach((mesh, i) => expect(mesh.material).toBe(originals[i]));
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
    const terrainShader = normalShader();
    normal.onBeforeCompile(terrainShader as Parameters<MeshNormalMaterial['onBeforeCompile']>[0], renderer);
    expect(terrainShader).toEqual(normalShader()); // No coverage discard; stock packing/log depth.
  });

  it.each(['traversal', 'clear', 'draw'])('restores materials and render state after a %s error, then recovers', failure => {
    const f = fixture(), { stub, renderer, color } = rendererStub();
    const pass = own(new SurfaceNormalPass(f.scene, f.camera));
    pass.renderPass.selection = new Selection([f.solid], 9);
    const meshes = [f.solid, f.arrayMesh, f.water, f.water2, f.terrain, f.child];
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

describe('terrain normal material cache and shared uniforms', () => {
  it('reuses one override per source and follows live uniforms without leaking patch phases between materials', () => {
    const f = fixture(), { stub, renderer } = rendererStub();
    const resource = own(createTerrainSurfaceNoise(31));
    const first = terrainSource(resource, [3_500_001, 4_600_002, -2_600_003]);
    const second = terrainSource(resource, [3_510_001, 4_601_002, -2_602_003]);
    f.terrain.material = first;
    const shared = new Mesh(f.terrain.geometry, first), other = new Mesh(f.terrain.geometry, second);
    f.scene.add(shared, other);
    const pass = own(new SurfaceNormalPass(f.scene, f.camera));
    const cached: MeshNormalMaterial[] = [];
    stub.render.mockImplementation(() => {
      expect(shared.material).toBe(f.terrain.material);
      expect(other.material).not.toBe(f.terrain.material);
      expect(f.terrain.material).not.toBe(f.solid.material);
      expect(f.terrain.material).not.toBe(f.water.material);
      if (cached.length) {
        expect(f.terrain.material).toBe(cached[0]); expect(other.material).toBe(cached[1]);
      } else cached.push(f.terrain.material as unknown as MeshNormalMaterial, other.material as unknown as MeshNormalMaterial);
    });
    pass.render(renderer, null, null);
    const shaders = cached.map(material => compileNormal(material, renderer));
    for (const [i, source] of [first, second].entries()) {
      for (const [name, uniform] of Object.entries(source.uniforms)) expect(shaders[i].uniforms[name], name).toBe(uniform);
    }
    expect(shaders[0].uniforms.terrainSurfaceNoiseTexture.value).toBe(shaders[1].uniforms.terrainSurfaceNoiseTexture.value);
    expect(shaders[0].uniforms.terrainSurfaceNoisePhase).not.toBe(shaders[1].uniforms.terrainSurfaceNoisePhase);
    const secondPhases = second.uniforms.terrainSurfaceNoisePhase.value.map((phase: Vector3) => phase.toArray());
    first.uniforms.terrainSurfaceCameraPositionM.value.set(3_500_050, 4_600_100, -2_600_100);
    first.uniforms.planetCenter.value.set(-50, -100, -150); // Render-origin rebase.
    first.uniforms.terrainSurfaceEnabled.value = 0;
    first.uniforms.terrainSurfaceNoisePhase.value = Array.from({ length: 4 }, () => new Vector3(0.1, 0.2, 0.3));
    const nextDayMap = own(new Texture()); first.uniforms.dayMap.value = nextDayMap;
    pass.render(renderer, null, null);
    expect(shaders[0].uniforms.terrainSurfaceCameraPositionM.value.toArray()).toEqual([3_500_050, 4_600_100, -2_600_100]);
    expect(shaders[0].uniforms.planetCenter.value.toArray()).toEqual([-50, -100, -150]);
    expect(shaders[0].uniforms.terrainSurfaceEnabled.value).toBe(0);
    expect(shaders[0].uniforms.terrainSurfaceNoisePhase.value[3].toArray()).toEqual([0.1, 0.2, 0.3]);
    expect(shaders[0].uniforms.dayMap.value).toBe(nextDayMap);
    expect(second.uniforms.terrainSurfaceNoisePhase.value.map((phase: Vector3) => phase.toArray())).toEqual(secondPhases);
    expect(second.uniforms.terrainSurfaceEnabled.value).toBe(1);
    expect(cached[0].customProgramCacheKey()).toBe(cached[1].customProgramCacheKey());
    expect(cached.map(material => material.version)).toEqual([0, 0]);
    expect([f.terrain.material, shared.material, other.material]).toEqual([first, first, second]);
  });

  it('evicts a disposed source exactly once and creates a fresh override if that source is reused', () => {
    const f = fixture(), { stub, renderer } = rendererStub();
    const resource = own(createTerrainSurfaceNoise(37));
    const source = terrainSource(resource, [6_371_000, 0, 0]); f.terrain.material = source;
    const add = vi.spyOn(source, 'addEventListener'), remove = vi.spyOn(source, 'removeEventListener');
    const textureDispose = vi.spyOn(resource.texture, 'dispose');
    const pass = own(new SurfaceNormalPass(f.scene, f.camera));
    let active!: MeshNormalMaterial;
    stub.render.mockImplementation(() => { active = f.terrain.material as unknown as MeshNormalMaterial; });
    pass.render(renderer, null, null); pass.render(renderer, null, null);
    expect(add).toHaveBeenCalledTimes(1);
    const release = add.mock.calls[0][1], previous = active;
    const dispose = vi.spyOn(previous, 'dispose');
    expect(source.hasEventListener('dispose', release)).toBe(true);
    source.dispose(); source.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('dispose', release);
    expect(source.hasEventListener('dispose', release)).toBe(false);
    expect(textureDispose).not.toHaveBeenCalled();
    pass.render(renderer, null, null);
    expect(active).not.toBe(previous); expect(add).toHaveBeenCalledTimes(2);
    expect(f.terrain.material).toBe(source);
    expect(compileNormal(active, renderer).uniforms.terrainSurfaceNoiseTexture.value).toBe(resource.texture);
  });

  it('releases every cached override and listener on pass disposal without disposing source assets', () => {
    const f = fixture(), { stub, renderer } = rendererStub();
    const resource = own(createTerrainSurfaceNoise(41));
    const first = terrainSource(resource, [6_371_000, 0, 0]), second = terrainSource(resource, [0, 6_371_000, 0]);
    f.terrain.material = first;
    const other = new Mesh(f.terrain.geometry, second); f.scene.add(other);
    const sources = [first, second];
    const listeners = sources.map(source => vi.spyOn(source, 'addEventListener'));
    const sourceDisposals = sources.map(source => vi.spyOn(source, 'dispose'));
    const assetDisposals = [resource.texture, first.uniforms.dayMap.value, second.uniforms.dayMap.value]
      .map(texture => vi.spyOn(texture, 'dispose'));
    const pass = own(new SurfaceNormalPass(f.scene, f.camera));
    let cached: MeshNormalMaterial[] = [];
    stub.render.mockImplementation(() => {
      cached = [f.terrain.material, other.material] as unknown as MeshNormalMaterial[];
    });
    pass.render(renderer, null, null);
    const disposals = cached.map(material => vi.spyOn(material, 'dispose'));
    pass.dispose(); pass.dispose();
    disposals.forEach(dispose => expect(dispose).toHaveBeenCalledTimes(1));
    sourceDisposals.forEach(dispose => expect(dispose).not.toHaveBeenCalled());
    assetDisposals.forEach(dispose => expect(dispose).not.toHaveBeenCalled());
    sources.forEach((source, i) => {
      expect(source.hasEventListener('dispose', listeners[i].mock.calls[0][1])).toBe(false);
      source.dispose();
    });
    disposals.forEach(dispose => expect(dispose).toHaveBeenCalledTimes(1));
    expect([f.terrain.material, other.material]).toEqual(sources);
  });

  it('restores terrain after a failed draw and reuses the live cache on the next frame', () => {
    const f = fixture(), { stub, renderer } = rendererStub();
    const resource = own(createTerrainSurfaceNoise(43));
    const source = terrainSource(resource, [0, 0, 6_371_000]); f.terrain.material = source;
    const add = vi.spyOn(source, 'addEventListener');
    const pass = own(new SurfaceNormalPass(f.scene, f.camera));
    let cached!: MeshNormalMaterial;
    stub.render.mockImplementationOnce(() => {
      cached = f.terrain.material as unknown as MeshNormalMaterial;
      throw new Error('terrain draw failed');
    });
    expect(() => pass.render(renderer, null, null)).toThrow('terrain draw failed');
    expect(f.terrain.material).toBe(source);
    const dispose = vi.spyOn(cached, 'dispose');
    stub.render.mockImplementation(() => { expect(f.terrain.material).toBe(cached); });
    pass.render(renderer, null, null);
    expect(add).toHaveBeenCalledTimes(1); expect(dispose).not.toHaveBeenCalled();
    expect(f.terrain.material).toBe(source);
    pass.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
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

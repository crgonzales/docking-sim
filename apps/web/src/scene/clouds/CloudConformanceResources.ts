import {
  Color, Data3DTexture, DataArrayTexture, DataTexture, DepthTexture, DoubleSide,
  FloatType, Mesh, MeshBasicMaterial, NearestFilter, NoToneMapping, PerspectiveCamera,
  PlaneGeometry, RGBAFormat, Scene, UnsignedIntType, Vector4, WebGLRenderTarget,
  type Texture, type WebGLRenderer,
} from 'three';

/** Probe-only resources. The caller draws production cloud materials into output. */
export class CloudConformanceResources {
  readonly size = 9;
  readonly camera = new PerspectiveCamera(30, 1, 0.5, 10_000);
  readonly depth = new WebGLRenderTarget(this.size, this.size, {
    type: FloatType,
    depthBuffer: true, depthTexture: new DepthTexture(this.size, this.size, UnsignedIntType),
  });
  readonly output = new WebGLRenderTarget(this.size, this.size, {
    count: 2, type: FloatType, format: RGBAFormat, depthBuffer: false,
    minFilter: NearestFilter, magFilter: NearestFilter,
  });
  readonly one2D = this.texture2D(255);
  readonly zero2D = this.texture2D(0);
  readonly zero3D = this.texture3D(0);
  readonly one3D = this.texture3D(255);
  readonly noise3D = this.texture3D(128);
  readonly shadowArray = new DataArrayTexture(new Uint8Array(16), 1, 1, 4);
  private readonly scene = new Scene();
  private readonly plane = new Mesh(new PlaneGeometry(20_000, 20_000), new MeshBasicMaterial({ side: DoubleSide }));
  private readonly textures: Texture[];

  constructor(private readonly renderer: WebGLRenderer) {
    this.textures = [this.one2D, this.zero2D, this.zero3D, this.one3D, this.noise3D, this.shadowArray];
    this.shadowArray.format = RGBAFormat;
    this.shadowArray.needsUpdate = true;
    this.camera.lookAt(-1, 0, 0);
    this.camera.updateMatrixWorld();
    this.plane.rotation.y = Math.PI / 2;
    // Opaque BasicMaterial otherwise forces alpha=1. Keep depth/opaque drawing
    // while letting surface fixtures supply the scene's material metadata.
    this.plane.material.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
        '#include <opaque_fragment>\n  gl_FragColor.a = opacity;');
    };
    this.scene.add(this.plane);
  }

  private texture2D(value: number): DataTexture {
    const texture = new DataTexture(new Uint8Array([value, value, value, value]), 1, 1, RGBAFormat);
    texture.needsUpdate = true;
    return texture;
  }

  private texture3D(value: number): Data3DTexture {
    const texture = new Data3DTexture(new Uint8Array([value, value, value, value]), 1, 1, 1);
    texture.format = RGBAFormat;
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.needsUpdate = true;
    return texture;
  }

  /** Restore renderer state synchronously, before any asynchronous GPU readback. */
  draw(action: () => void): void {
    const r = this.renderer;
    const target = r.getRenderTarget();
    const face = r.getActiveCubeFace();
    const mip = r.getActiveMipmapLevel();
    const viewport = r.getViewport(new Vector4());
    const scissor = r.getScissor(new Vector4());
    const scissorTest = r.getScissorTest();
    const color = r.getClearColor(new Color());
    const alpha = r.getClearAlpha();
    const autoClear = r.autoClear;
    const toneMapping = r.toneMapping;
    try {
      r.autoClear = true;
      r.toneMapping = NoToneMapping;
      r.setScissorTest(false);
      r.setClearColor(0, 0);
      action();
    } finally {
      r.setRenderTarget(target, face, mip);
      r.setViewport(viewport);
      r.setScissor(scissor);
      r.setScissorTest(scissorTest);
      r.setClearColor(color, alpha);
      r.autoClear = autoClear;
      r.toneMapping = toneMapping;
    }
  }

  /** Ordinary geometry writes the same logarithmic depth encoding as the scene. */
  renderTerrain(distanceM: number | null, color?: readonly [number, number, number], materialAlpha = 1): void {
    this.plane.visible = distanceM !== null;
    this.plane.material.color.setRGB(...(color ?? [1, 1, 1]));
    this.plane.material.opacity = materialAlpha;
    this.plane.position.set(-(distanceM ?? 0), 0, 0);
    this.draw(() => {
      this.renderer.setRenderTarget(this.depth);
      this.renderer.render(this.scene, this.camera);
    });
  }

  async readCenter(target = this.output): Promise<readonly number[]> {
    const rgba = new Float32Array(4);
    // This one-pixel fixture read must also finish in a throttled background tab.
    this.renderer.readRenderTargetPixels(target, 4, 4, 1, 1, rgba);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return Array.from(rgba);
  }

  dispose(): void {
    this.depth.dispose();
    this.depth.depthTexture?.dispose();
    this.output.dispose();
    this.textures.forEach(texture => texture.dispose());
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.scene.clear();
  }
}

/** Analytical homogeneous-medium oracle, not a second raymarch implementation. */
export function homogeneousCloudExpected(extinctionPerM: number, scatteringPerM: number, lengthM: number): Vector4 {
  const transmittance = Math.exp(-extinctionPerM * lengthM);
  const radiance = extinctionPerM > 0 ? scatteringPerM / extinctionPerM * (1 - transmittance) : 0;
  return new Vector4(radiance, radiance, radiance, 1 - transmittance);
}

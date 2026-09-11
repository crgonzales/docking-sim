import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AerialPerspectiveEffect } from '@takram/three-atmosphere';
import { CloudsEffect } from '@takram/three-clouds';
import { BlendFunction, EffectPass, ToneMappingEffect } from 'postprocessing';
import { PerspectiveCamera, ShaderMaterial, Uniform } from 'three';
import { WATER_BRDF_GLSL, WATER_ROUGHNESS, waterAerialLighting } from './libraryWaterLighting';
import { stableAerialDepth } from './libraryDepth';
import { stableAerialShadowStorage } from './libraryCloudShadowStorage';
import { blendAerialCloudShadows } from './libraryCloudShadowBlend';
import { ShadowDiagnosticAerialEffect } from './libraryCloudShadowDiagnostics';

// Execute the emitted scalar GLSL, with only type syntax translated to JS.
const scalar = WATER_BRDF_GLSL.replace(/float\s+(\w+)\s*\(([^)]*)\)\s*\{/g,
  (_, name, args: string) => `function ${name}(${args.replace(/\bfloat\b/g, '')}) {`)
  .replace(/\bfloat\s+/g, 'let ');
const { waterFresnel: fresnel, waterGgx: ggx, waterRadianceChannel: radiance } = new Function(
  'clamp', 'max', 'sqrt', scalar + '\nreturn { waterFresnel, waterGgx, waterRadianceChannel };',
)((x: number, a: number, b: number) => Math.max(a, Math.min(b, x)), Math.max, Math.sqrt) as {
  waterFresnel(c: number): number;
  waterGgx(nv: number, nl: number, nh: number, vh: number, roughness: number): number;
  waterRadianceChannel(a: number, sun: number, sky: number, reflected: number, nv: number, nl: number, spec: number): number;
};
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('bounded statistical water lighting', () => {
  it('matches dielectric endpoint oracles and is bounded and monotonic', () => {
    expect(fresnel(1)).toBeCloseTo(((1.333 - 1) / (1.333 + 1)) ** 2, 14);
    expect(fresnel(0)).toBe(1);
    let previous = 1;
    for (let i = 0; i <= 1000; i++) {
      const value = fresnel(i / 1000);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(previous + 1e-14);
      previous = value;
    }
  });

  it('has finite reciprocal GGX and zero backface/sunset contribution', () => {
    for (const nv of [0, 1e-9, 0.01, 0.5, 1]) for (const nl of [0, 1e-9, 0.1, 1]) {
      for (const roughness of [0, 0.12, WATER_ROUGHNESS, 0.65, 10]) {
        const value = ggx(nv, nl, 1, 0.5, roughness);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBe(ggx(nl, nv, 1, 0.5, roughness));
        if (nv === 0 || nl === 0) expect(value).toBe(0);
        expect(radiance(0.026, 0, 0, 0, nv, nl, value)).toBe(0);
      }
    }
    expect(ggx(1, -1, 0, 0, WATER_ROUGHNESS)).toBe(0);
  });

  it('integrates the GGX reflection lobe to at most incident energy', () => {
    // Deterministic GGX half-vector quadrature. The independent PDF/Jacobian
    // integrates the shader BRDF over the incident hemisphere, including glint.
    for (const roughness of [0.12, WATER_ROUGHNESS, 0.65]) for (const nv of [1, 0.5, 0.05]) {
      const a2 = roughness ** 4, vx = Math.sqrt(1 - nv * nv);
      let energy = 0;
      const n = 128, m = 256;
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        const u = (i + 0.5) / n;
        const nh = Math.sqrt((1 - u) / (1 + (a2 - 1) * u));
        const hx = Math.sqrt(1 - nh * nh) * Math.cos(2 * Math.PI * (j + 0.5) / m);
        const vh = vx * hx + nv * nh;
        const nl = 2 * vh * nh - nv;
        if (vh <= 0 || nl <= 0) continue;
        const d = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2);
        const pdf = d * nh / (4 * vh);
        energy += ggx(nv, nl, nh, vh, roughness) * nl / pdf;
      }
      energy /= n * m;
      expect(energy).toBeGreaterThan(0);
      expect(energy).toBeLessThanOrEqual(1.001);
    }
  });

  it('keeps uniform-sky energy bounded and cloud attenuation linear without a night floor', () => {
    for (const nv of [0, 1e-6, 0.1, 0.5, 1]) {
      // Unit sky radiance has irradiance pi. Reflection plus body <= one.
      expect(radiance(0.026, 0, Math.PI, 1, nv, 0.5, 0)).toBeLessThanOrEqual(1);
      const spec = ggx(nv, 0.5, 0.9, 0.8, WATER_ROUGHNESS);
      const dark = radiance(0.026, 0, 2, 0.4, nv, 0.5, spec);
      const clear = radiance(0.026, 10, 2, 0.4, nv, 0.5, spec);
      expect(radiance(0.026, 2.5, 2, 0.4, nv, 0.5, spec)).toBeCloseTo(dark + 0.25 * (clear - dark), 12);
    }
  });
});

describe('pinned water metadata and aerial composition', () => {
  it('keeps globe classification in the day-map UV and streamed water semantic', () => {
    const earth = read('./Earth.tsx');
    const terrain = read('./terrain/terrainShaders.ts');
    expect(earth).toContain('vec2 libraryMapUv = earthMapUv(vUv);');
    expect(earth).toContain('float libraryWater = earthWaterFraction(texture2D(specMap, libraryMapUv).r);');
    expect(earth).toContain('vec4(earthSurfaceAlbedo(texture2D(dayMap, libraryMapUv).rgb), 1.0 - 0.5 * libraryWater)');
    expect(earth).toContain('specMap.colorSpace = NoColorSpace');
    expect(terrain).toMatch(/if \(vWaterMask < 0.5\) discard;\s*#ifdef LIBRARY_LIGHTING/);
    expect(terrain).toContain('gl_FragColor = vec4(0.015, 0.04, 0.07, 0.5);');
    expect(terrain).toContain('gl_FragColor = vTerrainWaterMask >= 0.5');
    expect(terrain).toContain(': vec4(albedo, 1.0);');
    expect(earth).toContain('transparent: !LIBRARY_RENDERER');
    expect(terrain.match(/transparent: !LIBRARY_RENDERER/g)).toHaveLength(2);
  });

  it('composes with depth/shadow adapters, applies attenuation before BRDF and aerial once', () => {
    const aerial = new AerialPerspectiveEffect(new PerspectiveCamera());
    const diagnostic = new ShadowDiagnosticAerialEffect(new PerspectiveCamera());
    try {
      const source = aerial.getFragmentShader();
      const patched = waterAerialLighting(source);
      const other = (s: string) => blendAerialCloudShadows(stableAerialShadowStorage(stableAerialDepth(s)));
      expect(waterAerialLighting(other(source))).toBe(other(patched));
      const diagnosticSource = diagnostic.getFragmentShader();
      const composed = diagnosticSource.includes('// WATER_AERIAL_LIGHTING') ? diagnosticSource : waterAerialLighting(diagnosticSource);
      expect(composed).toContain('cloudSurfaceShadowStrength');
      expect(composed.indexOf('sunIrradiance *= sunTransmittance')).toBeLessThan(composed.indexOf('return mix(diffuseRadiance, waterSurfaceRadiance'));
      expect(composed.match(/applyTransmittanceInscatter\(positionECEF, shadowLength, radiance\);/g)).toHaveLength(1);
      expect(composed).toContain('waterOpaque ? 1.0 : inputColor.a');
      expect(composed).toContain('!degenerateNormal && inputColor.a >= 0.5');
      expect(composed).toContain('waterLightingEnabled <= 0.0) return diffuseRadiance');
      expect(composed).toContain('GetSunAndSkyIrradiance(positionECEF, waterIlluminationNormal(positionECEF, normal, waterFraction * waterLightingEnabled), sunDirection, skyIrradiance)');
      expect(composed.match(/uniform float waterLightingEnabled;/g)).toHaveLength(1);
      expect(() => waterAerialLighting(patched)).toThrow();
      expect(() => waterAerialLighting(source.replace('outputColor = vec4(radiance, inputColor.a);', ''))).toThrow();
    } finally { aerial.dispose(); diagnostic.dispose(); }
  });

  it('preserves RGBA through actual cloud skip and NORMAL blend shader assembly', () => {
    const camera = new PerspectiveCamera();
    const clouds = new CloudsEffect(camera);
    class WaterEffect extends AerialPerspectiveEffect {
      constructor() {
        super(camera);
        this.uniforms.set('waterLightingEnabled', new Uniform(1));
        this.setFragmentShader(waterAerialLighting(this.getFragmentShader()));
      }
    }
    const aerial = new WaterEffect();
    const cloudPass = new EffectPass(camera, clouds);
    const aerialPass = new EffectPass(camera, aerial, new ToneMappingEffect());
    try {
      clouds.skipRendering = true;
      expect(clouds.defines.has('SKIP_RENDERING')).toBe(true);
      expect(clouds.getFragmentShader()).toContain('#ifdef SKIP_RENDERING\n  outputColor = inputColor;');
      expect(aerial.blendMode.blendFunction).toBe(BlendFunction.NORMAL);
      expect(aerial.blendMode.opacity.value).toBe(1);
      cloudPass.recompile(); aerialPass.recompile();
      expect((cloudPass.fullscreenMaterial as ShaderMaterial).fragmentShader).toContain('return mix(dst,src,opacity);');
      const assembled = (aerialPass.fullscreenMaterial as ShaderMaterial).fragmentShader;
      expect(assembled).toContain('waterOpaque ? 1.0 : inputColor.a');
      expect(assembled).toContain('e0WaterLightingEnabled');
      expect(assembled.indexOf('e0MainImage(color0, UV, color1)')).toBeLessThan(assembled.indexOf('e1MainImage(color0, UV, color1)'));
    } finally { cloudPass.dispose(); aerialPass.dispose(); }
  });
});

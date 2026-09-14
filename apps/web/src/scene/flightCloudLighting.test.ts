import { afterEach, describe, expect, it } from 'vitest';
import { MeshStandardMaterial, ShaderLib, Uniform, Vector3, type WebGLRenderer } from 'three';
import { createFlightCloudLightingBridge } from './flightCloudLighting';

const materials: MeshStandardMaterial[] = [];
afterEach(() => materials.splice(0).forEach((material) => material.dispose()));

function compile(material: MeshStandardMaterial) {
  const shader = {
    uniforms: {} as Record<string, Uniform>,
    vertexShader: ShaderLib.standard.vertexShader,
    fragmentShader: ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(
    shader as unknown as Parameters<MeshStandardMaterial['onBeforeCompile']>[0],
    undefined as unknown as WebGLRenderer,
  );
  return shader;
}

describe('flight local PBR cloud-lighting bridge', () => {
  it('composes with Three standard materials and binds live uniforms by identity', () => {
    const bridge = createFlightCloudLightingBridge();
    const material = new MeshStandardMaterial();
    materials.push(material);
    const release = bridge.registerMaterial(material);
    const initial = compile(material);
    expect(initial.vertexShader).toContain('volumetricLocalPositionECEFM');
    expect(initial.fragmentShader).toContain('volumetricSunTransmittance');
    expect(initial.fragmentShader).toContain('volumetricSkyVisibility');
    expect(initial.fragmentShader).toContain('directLight.color *= volumetricLocalDirectCloudVisibility');
    expect(initial.fragmentShader).toContain('irradiance *= volumetricLocalSkyCloudVisibility');
    expect(material.defines?.LIBRARY_LIGHTING).toBeUndefined();

    const sun = new Uniform(new Vector3(1, 0, 0));
    bridge.setBindings({ volumetricWeatherSunDirectionECEF: sun });
    bridge.setEnabled(true);
    // A cached Three program does not call onBeforeCompile again. The already
    // compiled map must adopt the borrowed identity, then drop it on clear.
    expect(initial.uniforms.volumetricWeatherSunDirectionECEF).toBe(sun);
    sun.value.set(0, 1, 0);
    expect(initial.uniforms.volumetricWeatherSunDirectionECEF.value).toEqual(new Vector3(0, 1, 0));
    bridge.clearBindings();
    expect(initial.uniforms.volumetricWeatherSunDirectionECEF).not.toBe(sun);
    expect(initial.uniforms.volumetricLocalCloudLightingEnabled.value).toBe(0);
    const replacement = new Uniform(new Vector3(0, 0, 1));
    bridge.setBindings({ volumetricWeatherSunDirectionECEF: replacement });
    bridge.setEnabled(true);
    expect(initial.uniforms.volumetricWeatherSunDirectionECEF).toBe(replacement);
    expect(bridge.uniforms.volumetricLocalCloudLightingEnabled?.value).toBe(1);

    release();
    expect(material.defines?.LIBRARY_LIGHTING).toBeUndefined();
  });

  it('disables and removes borrowed bindings before a replay cleanup', () => {
    const bridge = createFlightCloudLightingBridge();
    const sun = new Uniform(new Vector3(1, 0, 0));
    bridge.setBindings({ volumetricWeatherSunDirectionECEF: sun });
    bridge.setEnabled(true);
    bridge.clearBindings();
    expect(bridge.uniforms.volumetricWeatherSunDirectionECEF).not.toBe(sun);
    expect(bridge.uniforms.volumetricLocalCloudLightingEnabled?.value).toBe(0);
  });

  it.each([false, true])('releases duplicate owners in either order, once each (%s)', (reverse) => {
    const bridge = createFlightCloudLightingBridge();
    const material = new MeshStandardMaterial();
    materials.push(material);
    const originalCompile = material.onBeforeCompile;
    const originalKey = material.customProgramCacheKey;
    const releases = [bridge.registerMaterial(material), bridge.registerMaterial(material)];
    if (reverse) releases.reverse();
    releases[0]!(); releases[0]!();
    expect(material.onBeforeCompile).not.toBe(originalCompile);
    releases[1]!(); releases[1]!();
    expect(material.onBeforeCompile).toBe(originalCompile);
    expect(material.customProgramCacheKey).toBe(originalKey);
    const finalRelease = bridge.registerMaterial(material);
    expect(compile(material).uniforms.volumetricLocalCloudLightingEnabled.value).toBe(0);
    finalRelease();
  });

});

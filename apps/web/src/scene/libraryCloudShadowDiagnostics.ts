import { Uniform } from 'three';
import { StableAerialPerspectiveEffect } from './libraryDepth';
import { stableAerialShadowStorage } from './libraryCloudShadowStorage';
import { blendAerialCloudShadows } from './libraryCloudShadowBlend';
import { PROBE_WATER_REFLECTIONS } from './renderProbeConfig';
import { waterAerialLighting } from './libraryWaterLighting';

// Probe-only switches alter composition, never the cloud density or sun.
export const cloudShadowProbe = { mode: 'on' as 'on' | 'off' | 'mask' | 'lighting' | 'normals', overlay: true, range: 'fitted' as 'fitted' | 'original', waterReflections: PROBE_WATER_REFLECTIONS };

export class ShadowDiagnosticAerialEffect extends StableAerialPerspectiveEffect {
  readonly shadowStrength = new Uniform(1);
  readonly shadowDiagnostic = new Uniform(0);
  readonly cloudOverlay = new Uniform(1);
  readonly waterLighting = new Uniform(1);
  constructor(...args: ConstructorParameters<typeof StableAerialPerspectiveEffect>) {
    super(...args);
    this.uniforms.set('cloudSurfaceShadowStrength', this.shadowStrength);
    this.uniforms.set('cloudSurfaceShadowDiagnostic', this.shadowDiagnostic);
    this.uniforms.set('cloudOverlayEnabled', this.cloudOverlay);
    this.uniforms.set('waterLightingEnabled', this.waterLighting);
    let source = 'uniform float cloudSurfaceShadowStrength;\nuniform float cloudSurfaceShadowDiagnostic;\nuniform float cloudOverlayEnabled;\n' + this.getFragmentShader();
    const replacements = [
      ['vec4 overlay = texture(overlayBuffer, uv);',
        'vec4 overlay = texture(overlayBuffer, uv) * cloudOverlayEnabled * (1.0 - step(0.5, cloudSurfaceShadowDiagnostic));'],
      ['float sunTransmittance = exp(-opticalDepth);',
        'float sunTransmittance = mix(1.0, exp(-opticalDepth), cloudSurfaceShadowStrength);'],
      ['  vec3 radiance;\n',
        `  if (cloudSurfaceShadowDiagnostic > 2.5) { outputColor = vec4(viewNormal * 0.5 + 0.5, 1.0); return; }
  #ifdef HAS_LIGHTING_MASK
  if (cloudSurfaceShadowDiagnostic > 1.5) { outputColor = vec4(vec3(texture(lightingMaskBuffer, uv).LIGHTING_MASK_CHANNEL_), 1.0); return; }
  #endif
  if (cloudSurfaceShadowDiagnostic > 0.5) { outputColor = vec4(vec3(sunTransmittance), 1.0); return; }
  vec3 radiance;
`],
    ];
    for (const [before, after] of replacements) {
      if (source.split(before).length !== 2) throw new Error('Pinned aerial shader changed; review shadow diagnostics');
      source = source.replace(before, after);
    }
    this.setFragmentShader(waterAerialLighting(blendAerialCloudShadows(stableAerialShadowStorage(source))));
  }
}

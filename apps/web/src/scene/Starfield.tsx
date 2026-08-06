import { useEffect } from 'react';
import { useLoader, useThree } from '@react-three/fiber';
import { EquirectangularReflectionMapping, SRGBColorSpace, TextureLoader } from 'three';

/**
 * Milky Way background from the ESO equirectangular panorama.
 * Background only — no image-based lighting (space stays black, the sun is
 * the only light). Intensity is clamped below the bloom threshold (1.0) so
 * stars never bloom; bloom is reserved for night lights and sun glints.
 */
const STARMAP_URL = '/assets/hdri/starmap.jpg';
const BACKGROUND_INTENSITY = 0.6;

export function Starfield() {
  const texture = useLoader(TextureLoader, STARMAP_URL);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    texture.mapping = EquirectangularReflectionMapping;
    texture.colorSpace = SRGBColorSpace;
    const prevBackground = scene.background;
    const prevIntensity = scene.backgroundIntensity;
    scene.background = texture;
    scene.backgroundIntensity = BACKGROUND_INTENSITY;
    return () => {
      scene.background = prevBackground;
      scene.backgroundIntensity = prevIntensity;
    };
  }, [texture, scene]);

  return null;
}

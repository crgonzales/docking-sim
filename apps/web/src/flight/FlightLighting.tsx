import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, DirectionalLight, HemisphereLight, Object3D, Vector3, type Texture } from 'three';
import { getSunLightColor } from '@takram/three-atmosphere';
import { Ellipsoid } from '@takram/three-geospatial';
import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M, SKY_CONFIG } from '../scene/sky/skyConfig';
import { SUN_DIR } from '../scene/sun';
import type { WorldFrame } from '../scene/worldFrame';
import type { FlightEnvironmentSource } from './flightEnvironment';

const METERS = 1 / SKY_CONFIG.renderScaleMPerUnit;
const smooth = (lo: number, hi: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** One sun and one local shadow map, following the camera after its rebase. */
export function FlightLighting({ worldFrame, environment, localShadows, daylightRef, sunTransmittanceRef }: {
  worldFrame: WorldFrame;
  environment?: FlightEnvironmentSource;
  localShadows: boolean;
  daylightRef: MutableRefObject<number>;
  sunTransmittanceRef: MutableRefObject<Texture | null>;
}) {
  const { gl } = useThree();
  const sun = useRef<DirectionalLight>(null);
  const sky = useRef<HemisphereLight>(null);
  const background = useRef<Color>(null);
  const target = useMemo(() => new Object3D(), []);
  const scratch = useMemo(() => ({ up: new Vector3(), direction: new Vector3(),
    positionECEF: new Vector3(), sunECEF: new Vector3(),
    ellipsoid: new Ellipsoid(EARTH_RADIUS_M, EARTH_RADIUS_M, EARTH_RADIUS_M),
  }), []);
  useEffect(() => {
    if (!localShadows) return;
    const previous = gl.shadowMap.autoUpdate;
    // The first color render consumes needsUpdate. Normal/mask passes reuse it.
    gl.shadowMap.autoUpdate = false;
    return () => { gl.shadowMap.autoUpdate = previous; };
  }, [gl, localShadows]);
  useFrame(({ camera }) => {
    const light = sun.current!;
    const position = worldFrame.toWorld([camera.position.x, camera.position.y, camera.position.z]);
    scratch.up.set(position[0] + EARTH_CENTER_DISTANCE_M, position[1], position[2]).normalize();
    scratch.direction.copy(SUN_DIR);
    let day = 1, ambient = 1;
    if (environment) {
      scratch.direction.fromArray(environment.state.sunDirection);
      const elevation = scratch.up.dot(scratch.direction);
      day = smooth(0, 0.08, elevation);
      ambient = 0.12 + 0.88 * smooth(-0.12, 0.08, elevation);
    }
    daylightRef.current = day;
    light.intensity = 2.4 * day;
    light.color.setRGB(1, 1, 1);
    if (environment && sunTransmittanceRef.current) {
      scratch.positionECEF.set(position[0] + EARTH_CENTER_DISTANCE_M, -position[2], position[1]);
      scratch.sunECEF.set(scratch.direction.x, -scratch.direction.z, scratch.direction.y);
      // Share the atmosphere's actual transmittance: warm grazing sunlight,
      // without a second hand-tuned sunset color or duplicate texture loading.
      getSunLightColor(sunTransmittanceRef.current, scratch.positionECEF, scratch.sunECEF,
        light.color, { ellipsoid: scratch.ellipsoid, correctAltitude: true });
    }
    sky.current!.position.copy(scratch.up);
    sky.current!.intensity = environment ? 0.08 + 0.72 * ambient : 0.8;
    if (environment) {
      const brightness = 0.16 + 0.84 * ambient;
      background.current!.setRGB(0.557 * brightness, 0.694 * brightness, 0.78 * brightness);
    }
    target.position.copy(camera.position);
    target.updateMatrixWorld();
    light.position.copy(target.position).addScaledVector(scratch.direction, 200 * METERS);
    // Keep the shadow camera's up vector well away from the sun direction,
    // including noon, instead of letting lookAt become singular.
    light.shadow.camera.up.set(0, 1, 0);
    light.updateMatrixWorld();
    if (localShadows && day > 0) gl.shadowMap.needsUpdate = true;
  }, -0.5);
  return <>
    <color ref={background} attach="background" args={['#8eb1c7']} />
    <hemisphereLight ref={sky} args={['#d8edff', '#44515a', 0.8]} />
    <primitive object={target} />
    <directionalLight ref={sun} target={target} intensity={2.4} castShadow={localShadows}
      shadow-mapSize-width={1024} shadow-mapSize-height={1024}
      shadow-camera-left={-55 * METERS} shadow-camera-right={55 * METERS}
      shadow-camera-top={55 * METERS} shadow-camera-bottom={-55 * METERS}
      shadow-camera-near={0.5 * METERS} shadow-camera-far={450 * METERS}
      shadow-bias={-0.00005} shadow-normalBias={0.015 * METERS} />
  </>;
}

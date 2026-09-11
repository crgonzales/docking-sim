import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, DirectionalLight, HemisphereLight, Object3D, Vector3, type Texture } from 'three';
import { getSunLightColor, SkyLightProbe } from '@takram/three-atmosphere';
import { Ellipsoid } from '@takram/three-geospatial';
import { EARTH_CENTER_DISTANCE_M, EARTH_RADIUS_M, SKY_CONFIG } from '../scene/sky/skyConfig';
import { SUN_DIR } from '../scene/sun';
import type { WorldFrame } from '../scene/worldFrame';
import type { FlightEnvironmentSource } from './flightEnvironment';
import { disposeFlightShadowMap, updateFlightSkyProbe } from './flightLocalLighting';

const METERS = 1 / SKY_CONFIG.renderScaleMPerUnit;
const GROUND_BOUNCE_ALBEDO = 0.08;
const smooth = (lo: number, hi: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** One sun and one local shadow map, following the camera after its rebase. */
export function FlightLighting({ worldFrame, environment, localShadows, daylightRef, sunTransmittanceRef,
  skyIrradianceRef, shadowMapSize = 1024 }: {
  worldFrame: WorldFrame;
  environment?: FlightEnvironmentSource;
  localShadows: boolean;
  daylightRef: MutableRefObject<number>;
  sunTransmittanceRef: MutableRefObject<Texture | null>;
  skyIrradianceRef?: MutableRefObject<Texture | null>;
  shadowMapSize?: number;
}) {
  const { gl, invalidate } = useThree();
  const sun = useRef<DirectionalLight>(null);
  const sky = useRef<HemisphereLight>(null);
  const background = useRef<Color>(null);
  const target = useMemo(() => new Object3D(), []);
  const scratch = useMemo(() => ({ up: new Vector3(), direction: new Vector3(),
    positionECEF: new Vector3(), sunECEF: new Vector3(),
    groundIrradiance: new Vector3(), skyColor: new Color('#d8edff'), groundColor: new Color('#44515a'),
    ellipsoid: new Ellipsoid(EARTH_RADIUS_M, EARTH_RADIUS_M, EARTH_RADIUS_M),
  }), []);
  const probe = useMemo(() => {
    const value = new SkyLightProbe({ ellipsoid: scratch.ellipsoid, correctAltitude: true });
    value.intensity = 0;
    return value;
  }, [scratch]);
  const resolvedShadowMapSize = Math.max(1, Math.min(gl.capabilities.maxTextureSize,
    Math.floor(Number.isFinite(shadowMapSize) && shadowMapSize > 0 ? shadowMapSize : 1024)));
  useLayoutEffect(() => {
    const shadow = sun.current!.shadow;
    shadow.mapSize.setScalar(resolvedShadowMapSize);
    shadow.needsUpdate = true;
    invalidate();
    return () => { disposeFlightShadowMap(shadow); };
  }, [resolvedShadowMapSize, invalidate]);
  useLayoutEffect(() => () => {
    updateFlightSkyProbe(probe, null, scratch.positionECEF, scratch.sunECEF);
  }, [probe, scratch]);
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
    // The dynamic color already contains solar irradiance and relative luminance.
    light.intensity = environment ? day : 2.4;
    light.color.setRGB(1, 1, 1);
    scratch.positionECEF.set(position[0] + EARTH_CENTER_DISTANCE_M, -position[2], position[1]);
    scratch.sunECEF.set(scratch.direction.x, -scratch.direction.z, scratch.direction.y);
    if (environment && sunTransmittanceRef.current) {
      // Share the atmosphere's actual transmittance: warm grazing sunlight,
      // without a second hand-tuned sunset color or duplicate texture loading.
      getSunLightColor(sunTransmittanceRef.current, scratch.positionECEF, scratch.sunECEF,
        light.color, { ellipsoid: scratch.ellipsoid, correctAltitude: true });
    }
    const hasSkyProbe = updateFlightSkyProbe(probe,
      environment ? skyIrradianceRef?.current ?? null : null, scratch.positionECEF, scratch.sunECEF);
    const hemisphere = sky.current!;
    hemisphere.position.copy(scratch.up);
    if (hasSkyProbe) {
      // A dark ground reflects at most 8% of incident daylight toward the
      // underside. No second sky contribution or fixed nighttime bounce floor.
      const directGround = light.intensity * Math.max(0, scratch.up.dot(scratch.direction));
      const ground = probe.sh.getIrradianceAt(scratch.up, scratch.groundIrradiance);
      hemisphere.color.setRGB(0, 0, 0);
      hemisphere.groundColor.setRGB(
        Math.max(0, ground.x * probe.intensity + light.color.r * directGround),
        Math.max(0, ground.y * probe.intensity + light.color.g * directGround),
        Math.max(0, ground.z * probe.intensity + light.color.b * directGround),
      );
      hemisphere.intensity = GROUND_BOUNCE_ALBEDO;
    } else {
      // Bounded startup fallback, or the untouched static fixture hemisphere.
      hemisphere.color.copy(scratch.skyColor);
      hemisphere.groundColor.copy(scratch.groundColor);
      hemisphere.intensity = environment ? 0.2 * ambient : 0.8;
    }
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
    <hemisphereLight ref={sky} args={['#d8edff', '#44515a', environment ? 0.2 : 0.8]} />
    <primitive object={probe} dispose={null} />
    <primitive object={target} />
    <directionalLight ref={sun} target={target} intensity={environment ? 1 : 2.4} castShadow={localShadows}
      shadow-camera-left={-55 * METERS} shadow-camera-right={55 * METERS}
      shadow-camera-top={55 * METERS} shadow-camera-bottom={-55 * METERS}
      shadow-camera-near={0.5 * METERS} shadow-camera-far={450 * METERS}
      shadow-bias={-0.00005} shadow-normalBias={0.015 * METERS} />
  </>;
}

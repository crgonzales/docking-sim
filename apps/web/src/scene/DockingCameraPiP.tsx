import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import { conjugateQuaternion, rotateVector } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { shouldShowPip, useViewStore } from '../viewStore';
import { FRAME_TONE_MAPPING } from './Effects';
import { COCKPIT_CAMERA_NEAR, PIP_CAMERA_FAR } from './sky/skyConfig';
import { WorldFrame } from './worldFrame';

/**
 * Runs AFTER the main render: the EffectComposer owns the frame at priority 1,
 * so the PiP pass takes priority 2 — a negative priority would draw first and
 * be overwritten by the composer's full-viewport output.
 */
const PIP_RENDER_PRIORITY = 2;

const PIP_TONE_MAPPING_FRAGMENT = /* glsl */ `
  #include <tonemapping_pars_fragment>
  uniform sampler2D pipColor;
  varying vec2 vUv;

  void main() {
    vec4 color = texture2D(pipColor, vUv);
    color.rgb = ${FRAME_TONE_MAPPING.function}(color.rgb);
    gl_FragColor = color;
    #include <colorspace_fragment>
  }
`;

interface DockingCameraPassProps {
  readonly worldFrame: WorldFrame;
  readonly exposureRef: { readonly current: number };
}

/** Render the reduced-resolution docking view into the overlay's rectangle. */
export function DockingCameraPass({ worldFrame, exposureRef }: DockingCameraPassProps) {
  const { gl, scene } = useThree();
  const renderState = useTelemetryBus((state) => state.renderState);
  const visible = useViewStore((state) => state.pipVisible);
  const camera = useRef(new PerspectiveCamera(55, 1, COCKPIT_CAMERA_NEAR, PIP_CAMERA_FAR));
  const pipRender = useMemo(() => {
    const target = new WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      type: HalfFloatType,
    });
    target.texture.colorSpace = NoColorSpace;
    const material = new ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: PIP_TONE_MAPPING_FRAGMENT,
      uniforms: { pipColor: { value: target.texture } },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const compositeScene = new Scene();
    compositeScene.add(new Mesh(new PlaneGeometry(2, 2), material));
    const compositeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    compositeCamera.position.z = 1;
    return { target, material, compositeScene, compositeCamera };
  }, []);

  useEffect(() => () => {
    pipRender.target.dispose();
    pipRender.material.dispose();
    pipRender.compositeScene.traverse((object) => {
      if (object instanceof Mesh && object.geometry instanceof PlaneGeometry) object.geometry.dispose();
    });
  }, [pipRender]);

  useFrame(() => {
    // The rectangle comes from the measured DOM overlay (single source of
    // truth) so the crosshair and the rendered image always coincide.
    const rect = useViewStore.getState().pipRect;
    if (!visible || !renderState || !rect) return;
    const q_HB = conjugateQuaternion(renderState.q_BH);
    const originWorld = new Vector3(...renderState.r_hill_m)
      .add(new Vector3(...rotateVector(q_HB, [0, 1.6, 0])));
    const forward = new Vector3(...rotateVector(q_HB, [0, 1, 0]));
    const up = new Vector3(...rotateVector(q_HB, [0, 0, 1]));
    const origin = worldFrame.toRender([originWorld.x, originWorld.y, originWorld.z]);
    const lookAtWorld = originWorld.clone().add(forward.clone().multiplyScalar(30));
    const lookAt = worldFrame.toRender([lookAtWorld.x, lookAtWorld.y, lookAtWorld.z]);
    camera.current.aspect = rect.width / rect.height;
    camera.current.position.set(origin[0], origin[1], origin[2]);
    camera.current.up.copy(up);
    camera.current.lookAt(new Vector3(lookAt[0], lookAt[1], lookAt[2]));
    camera.current.updateProjectionMatrix();

    // Render targets are sized in PHYSICAL pixels, but setViewport/setScissor
    // take CSS pixels and multiply by the pixel ratio themselves. Mixing the
    // two spaces is the trap here: pre-scaling the rect and then handing it to
    // setViewport applies the ratio twice, which mispositions and oversizes
    // the on-screen composite on any DPR > 1 display.
    const pixelRatio = gl.getPixelRatio();
    const targetWidth = Math.max(1, Math.floor(rect.width * pixelRatio));
    const targetHeight = Math.max(1, Math.floor(rect.height * pixelRatio));
    const viewport = new Vector4();
    const scissor = new Vector4();
    gl.getViewport(viewport);
    gl.getScissor(scissor);
    const scissorTest = gl.getScissorTest();
    const previousTarget = gl.getRenderTarget();
    const previousAutoClear = gl.autoClear;
    // Target is sized to the PiP rectangle, NOT the drawing buffer: the PiP
    // camera's aspect already comes from that rect, so a full-buffer target
    // renders the same framing at the full screen's fragment count and then
    // throws most of it away — roughly 27x the shading work for a 320x240
    // inset on a 1080p buffer, every frame the docking view is up.
    if (pipRender.target.width !== targetWidth || pipRender.target.height !== targetHeight) {
      pipRender.target.setSize(targetWidth, targetHeight);
    }

    // Scene into the private target, then a viewport/scissor-limited quad
    // applies the same ACES function the composer uses. No setViewport here:
    // setRenderTarget already installs the target's own full viewport, in
    // physical pixels and without the pixel-ratio multiply.
    gl.autoClear = true;
    gl.setRenderTarget(pipRender.target);
    gl.setScissorTest(false);
    gl.clear(true, true, true);
    gl.render(scene, camera.current);

    gl.toneMappingExposure = exposureRef.current;
    gl.setRenderTarget(null);
    gl.setScissorTest(true);
    gl.setViewport(rect.x, rect.y, rect.width, rect.height);
    gl.setScissor(rect.x, rect.y, rect.width, rect.height);
    gl.render(pipRender.compositeScene, pipRender.compositeCamera);

    gl.autoClear = previousAutoClear;
    gl.setRenderTarget(previousTarget);
    gl.setViewport(viewport);
    gl.setScissor(scissor);
    gl.setScissorTest(scissorTest);
  }, PIP_RENDER_PRIORITY);

  return null;
}

function insideEnvelope(frame: NonNullable<ReturnType<typeof useTelemetryBus.getState>['frame']>): boolean {
  const docking = frame.docking;
  return docking !== null
    && docking.closing_mps >= 0.03
    && docking.closing_mps <= 0.10
    && docking.lateral_m <= 0.10
    && docking.misalign_deg <= 4
    && docking.rate_dps <= 0.15;
}

/** DOM overlay for the docking camera alignment crosshair and envelope data. */
export function DockingCameraPiP() {
  const frame = useTelemetryBus((state) => state.frame);
  const visible = useViewStore((state) => state.pipVisible);
  const setPipVisible = useViewStore((state) => state.setPipVisible);
  const setPipRect = useViewStore((state) => state.setPipRect);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPipVisible(shouldShowPip(frame));
  }, [frame, setPipVisible]);

  // Publish this overlay's measured rectangle (canvas-relative, y from
  // bottom) as the single source of truth for the WebGL scissor pass.
  useEffect(() => {
    if (!visible) {
      setPipRect(null);
      return;
    }
    const element = overlayRef.current;
    const canvas = document.querySelector('canvas');
    if (!element || !canvas) return;
    const measure = (): void => {
      const r = element.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      setPipRect({
        x: r.left - c.left,
        y: c.bottom - r.bottom,
        width: r.width,
        height: r.height,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      setPipRect(null);
    };
  }, [visible, setPipRect]);

  if (!visible) return null;
  const docking = frame?.docking ?? null;
  const safe = frame !== null && insideEnvelope(frame);
  return (
    <div className="docking-pip" ref={overlayRef} aria-label="docking camera">
      <div className="docking-pip-title">DOCKING CAM</div>
      <svg className="docking-crosshair" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="18" />
        <path d="M50 8v84M8 50h84" />
      </svg>
      {docking && (
        <div className={`docking-envelope ${safe ? 'inside' : 'outside'}`}>
          <span>CLS {docking.closing_mps.toFixed(2)} M/S</span>
          <span>LAT {docking.lateral_m.toFixed(2)} M</span>
          <span>ANG {docking.misalign_deg.toFixed(1)}°</span>
          <span>RATE {docking.rate_dps.toFixed(2)}°/S</span>
        </div>
      )}
    </div>
  );
}

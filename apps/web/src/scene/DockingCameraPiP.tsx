import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { PerspectiveCamera, Vector3, Vector4 } from 'three';
import { conjugateQuaternion, rotateVector } from '@docking/sim-core';
import { useTelemetryBus } from '../telemetry/bus';
import { shouldShowPip, useViewStore } from '../viewStore';

/**
 * Runs AFTER the main render: the EffectComposer owns the frame at priority 1,
 * so the PiP pass takes priority 2 — a negative priority would draw first and
 * be overwritten by the composer's full-viewport output.
 */
const PIP_RENDER_PRIORITY = 2;

/** Render the reduced-resolution docking view into the overlay's rectangle. */
export function DockingCameraPass() {
  const { gl, scene } = useThree();
  const renderState = useTelemetryBus((state) => state.renderState);
  const visible = useViewStore((state) => state.pipVisible);
  const camera = useRef(new PerspectiveCamera(55, 1, 0.05, 2_000));

  useFrame(() => {
    // The rectangle comes from the measured DOM overlay (single source of
    // truth) so the crosshair and the rendered image always coincide.
    const rect = useViewStore.getState().pipRect;
    if (!visible || !renderState || !rect) return;
    const q_HB = conjugateQuaternion(renderState.q_BH);
    const origin = new Vector3(...renderState.r_hill_m)
      .add(new Vector3(...rotateVector(q_HB, [0, 1.6, 0])));
    const forward = new Vector3(...rotateVector(q_HB, [0, 1, 0]));
    const up = new Vector3(...rotateVector(q_HB, [0, 0, 1]));
    camera.current.aspect = rect.width / rect.height;
    camera.current.position.copy(origin);
    camera.current.up.copy(up);
    camera.current.lookAt(origin.clone().add(forward.multiplyScalar(30)));
    camera.current.updateProjectionMatrix();

    const pixelRatio = gl.getPixelRatio();
    const x = Math.floor(rect.x * pixelRatio);
    const y = Math.floor(rect.y * pixelRatio);
    const width = Math.max(1, Math.floor(rect.width * pixelRatio));
    const height = Math.max(1, Math.floor(rect.height * pixelRatio));
    const viewport = new Vector4();
    const scissor = new Vector4();
    gl.getViewport(viewport);
    gl.getScissor(scissor);
    const scissorTest = gl.getScissorTest();
    gl.setScissorTest(true);
    gl.setViewport(x, y, width, height);
    gl.setScissor(x, y, width, height);
    gl.clearDepth();
    gl.render(scene, camera.current);
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

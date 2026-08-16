import { useEffect, useRef } from 'react';

/**
 * Wall-clock frame-rate readout. Writes straight to the DOM every 500 ms so
 * the counter itself never triggers React re-renders — the measurement must
 * not perturb the thing being measured. Exists so performance regressions show
 * up as a number instead of as "the mouse feels broken".
 */
export function FpsCounter() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frames = 0;
    let windowStart = performance.now();
    let raf = 0;
    const loop = (): void => {
      frames += 1;
      const now = performance.now();
      if (now - windowStart >= 500) {
        if (ref.current !== null) {
          ref.current.textContent = `${Math.round((frames * 1000) / (now - windowStart))} FPS`;
        }
        frames = 0;
        windowStart = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span className="hud-fps" ref={ref}>-- FPS</span>;
}

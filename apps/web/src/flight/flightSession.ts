import { createTrimmedFlight, flightInstruments, FLIGHT_DT_S, stepFlight, STILL_AIR, type FlightControls, type FlightEnvironment } from '@docking/sim-core';

export const FLIGHT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyW', 'KeyS', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'BracketLeft', 'BracketRight', 'KeyP', 'KeyR', 'KeyC']);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const approach = (value: number, target: number, amount: number) => value + clamp(target - value, -amount, amount);

/** Web-side pacing only. Pure flight dynamics consume complete fixed steps. */
export class FlightSession {
  state = createTrimmedFlight().state;
  controls: FlightControls = createTrimmedFlight().controls;
  environment: FlightEnvironment = { ...STILL_AIR, wind_N_m_s: [0, 0, 0] };
  paused = false;
  camera: 'CHASE' | 'NOSE' = 'CHASE';
  private keys = new Set<string>();
  private pointers = new Map<number, string>();
  private accumulator = 0;

  key(code: string, down: boolean): void {
    if (!down) { this.keys.delete(code); return; }
    if (this.keys.has(code)) return;
    this.keys.add(code);
    if (code === 'KeyP') this.togglePause();
    if (code === 'KeyR') this.reset();
    if (code === 'KeyC') this.camera = this.camera === 'CHASE' ? 'NOSE' : 'CHASE';
  }
  pointer(code: string, pointerId: number, down: boolean): void {
    if (down) this.pointers.set(pointerId, code);
    // Up, cancel and capture-loss can all arrive for the same gesture.
    else if (this.pointers.get(pointerId) === code) this.pointers.delete(pointerId);
  }
  releaseControls(): void {
    this.keys.clear();
    this.pointers.clear();
    this.controls = { ...this.controls, pitch: 0, roll: 0, yaw: 0 };
    this.accumulator = 0;
  }
  togglePause(): void { this.paused = !this.paused; this.releaseControls(); }
  loseFocus(): void { this.paused = true; this.releaseControls(); }
  reset(): void {
    const trim = createTrimmedFlight();
    this.state = trim.state; this.controls = trim.controls;
    this.environment = { ...STILL_AIR, wind_N_m_s: [0, 0, 0] };
    this.paused = false; this.releaseControls();
  }
  advance(delta_s: number): void {
    if (!Number.isFinite(delta_s) || delta_s < 0) return;
    if (this.paused || this.state.status !== 'FLYING') { this.accumulator = 0; return; }
    // Slow frames slow the simulation instead of spiraling into catch-up work.
    this.accumulator += Math.min(delta_s, 0.1);
    const pointerKeys = new Set(this.pointers.values());
    const held = (code: string) => Number(this.keys.has(code) || pointerKeys.has(code));
    while (this.accumulator + 1e-10 >= FLIGHT_DT_S) {
      const dt = FLIGHT_DT_S;
      this.controls = {
        ...this.controls,
        pitch: approach(this.controls.pitch, Math.max(held('KeyS'), held('ArrowDown')) - Math.max(held('KeyW'), held('ArrowUp')), 2 * dt),
        roll: approach(this.controls.roll, Math.max(held('KeyE'), held('ArrowRight')) - Math.max(held('KeyQ'), held('ArrowLeft')), 3 * dt),
        yaw: approach(this.controls.yaw, held('KeyD') - held('KeyA'), 2 * dt),
        throttle: clamp(this.controls.throttle + (Math.max(held('ShiftLeft'), held('ShiftRight')) - Math.max(held('ControlLeft'), held('ControlRight'))) * 0.3 * dt, 0, 1),
        trim: clamp(this.controls.trim + (held('BracketRight') - held('BracketLeft')) * 0.08 * dt, -1, 1),
      };
      this.state = stepFlight(this.state, this.controls, undefined, this.environment);
      this.accumulator -= dt;
      if (this.state.status !== 'FLYING') { this.releaseControls(); break; }
    }
  }
  instruments() { return flightInstruments(this.state, this.controls, undefined, this.environment); }
}

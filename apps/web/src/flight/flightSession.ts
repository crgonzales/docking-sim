import { createTrimmedFlight, flightInstruments, FLIGHT_DT_S, stepFlight, STILL_AIR, type FlightControls, type FlightEnvironment, type FlightState } from '@docking/sim-core';
import { FlightExerciseRun, idleFlightExercise, type FlightExerciseId, type FlightExerciseSnapshot } from './flightExercise';
import type { FlightFixture } from './flightFixture';

export const FLIGHT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyW', 'KeyS', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'BracketLeft', 'BracketRight', 'KeyP', 'KeyR', 'KeyC']);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const approach = (value: number, target: number, amount: number) => value + clamp(target - value, -amount, amount);
const PHYSICAL_CONTROL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyW', 'KeyS', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'BracketLeft', 'BracketRight']);

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
  private manualControls: FlightControls = { ...this.controls };
  private exerciseRun: FlightExerciseRun | null = null;
  private exerciseState: FlightExerciseSnapshot = idleFlightExercise();

  key(code: string, down: boolean): void {
    if (!down) { this.keys.delete(code); return; }
    if (this.keys.has(code)) return;
    if (PHYSICAL_CONTROL_KEYS.has(code)) this.cancelExercise();
    this.keys.add(code);
    if (code === 'KeyP') this.togglePause();
    if (code === 'KeyR') this.reset();
    if (code === 'KeyC') this.camera = this.camera === 'CHASE' ? 'NOSE' : 'CHASE';
  }
  pointer(code: string, pointerId: number, down: boolean): void {
    if (down) { this.cancelExercise(); this.pointers.set(pointerId, code); }
    // Up, cancel and capture-loss can all arrive for the same gesture.
    else if (this.pointers.get(pointerId) === code) this.pointers.delete(pointerId);
  }
  releaseControls(): void {
    this.keys.clear();
    this.pointers.clear();
    this.cancelExercise();
    this.releasePhysicalOwnership();
    this.accumulator = 0;
  }
  /** Freeze the aircraft for parked presentation and reconcile all manual state. */
  park(): void {
    this.cancelExercise();
    this.keys.clear();
    this.pointers.clear();
    this.manualControls = { ...this.manualControls, pitch: 0, roll: 0, yaw: 0, throttle: 0, trim: 0 };
    this.controls = { ...this.controls, pitch: 0, roll: 0, yaw: 0, throttle: 0, trim: 0 };
    this.paused = true;
    this.accumulator = 0;
  }
  togglePause(): void { this.paused = !this.paused; this.releaseControls(); }
  loseFocus(): void { this.paused = true; this.releaseControls(); }
  reset(): void {
    this.cancelExercise();
    const trim = createTrimmedFlight();
    this.state = trim.state; this.controls = trim.controls; this.manualControls = { ...trim.controls };
    this.environment = { ...STILL_AIR, wind_N_m_s: [0, 0, 0] };
    this.paused = false; this.keys.clear(); this.pointers.clear(); this.accumulator = 0;
  }
  startExercise(id: FlightExerciseId): void {
    this.reset();
    const trim = createTrimmedFlight();
    this.exerciseRun = new FlightExerciseRun(id, { ...trim.controls });
    this.exerciseState = this.exerciseRun.snapshot();
  }
  stopExercise(): void {
    if (!this.exerciseRun) return;
    this.exerciseState = this.exerciseRun.snapshot('STOPPED');
    this.exerciseRun = null;
    this.paused = true;
    this.releaseControls();
  }
  exerciseSnapshot(): FlightExerciseSnapshot { return { ...this.exerciseState }; }
  setThrottle(value: number): void {
    if (!Number.isFinite(value)) return;
    this.cancelExercise();
    this.manualControls.throttle = clamp(value, 0, 1);
    this.controls.throttle = this.manualControls.throttle;
  }
  setWind(wind_N_m_s: [number, number, number]): void {
    if (wind_N_m_s.some((value) => !Number.isFinite(value))) return;
    this.cancelExercise();
    this.environment.wind_N_m_s = [...wind_N_m_s];
  }
  applyFixture(fixture: FlightFixture): void {
    this.cancelExercise();
    this.setThrottle(fixture.controls.throttle);
    this.setWind([...fixture.environment.wind_N_m_s]);
    this.state = {
      ...fixture.state,
      position_N_m: [...fixture.state.position_N_m], velocity_N_m_s: [...fixture.state.velocity_N_m_s],
      q_BN: [...fixture.state.q_BN], omega_B_rad_s: [...fixture.state.omega_B_rad_s],
    };
    this.controls = { ...fixture.controls };
    this.manualControls = { ...fixture.controls };
    this.environment = { ...fixture.environment, wind_N_m_s: [...fixture.environment.wind_N_m_s] };
    this.camera = fixture.camera;
    this.paused = true;
    this.accumulator = 0;
    this.keys.clear(); this.pointers.clear();
  }
  advance(delta_s: number): void {
    if (!Number.isFinite(delta_s) || delta_s < 0) return;
    if (this.state.status !== 'FLYING') {
      if (this.exerciseRun) this.finishExercise('TERMINAL', this.state.status);
      this.paused = true; this.releaseControls(); return;
    }
    if (this.paused) { this.accumulator = 0; return; }
    // Slow frames slow the simulation instead of spiraling into catch-up work.
    this.accumulator += Math.min(delta_s, 0.1);
    const pointerKeys = new Set(this.pointers.values());
    const held = (code: string) => Number(this.keys.has(code) || pointerKeys.has(code));
    while (this.accumulator + 1e-10 >= FLIGHT_DT_S) {
      const dt = FLIGHT_DT_S;
      const manualTarget = {
        ...this.manualControls,
        pitch: Math.max(held('KeyS'), held('ArrowDown')) - Math.max(held('KeyW'), held('ArrowUp')),
        roll: Math.max(held('KeyE'), held('ArrowRight')) - Math.max(held('KeyQ'), held('ArrowLeft')),
        yaw: held('KeyD') - held('KeyA'),
        throttle: clamp(this.manualControls.throttle + (Math.max(held('ShiftLeft'), held('ShiftRight')) - Math.max(held('ControlLeft'), held('ControlRight'))) * 0.3 * dt, 0, 1),
        trim: clamp(this.manualControls.trim + (held('BracketRight') - held('BracketLeft')) * 0.08 * dt, -1, 1),
      };
      this.manualControls = { ...this.manualControls, throttle: manualTarget.throttle, trim: manualTarget.trim };
      const target = this.exerciseRun?.sample() ?? manualTarget;
      this.controls = {
        ...this.controls,
        pitch: approach(this.controls.pitch, target.pitch, 2 * dt), roll: approach(this.controls.roll, target.roll, 3 * dt), yaw: approach(this.controls.yaw, target.yaw, 2 * dt),
        throttle: this.exerciseRun ? target.throttle : manualTarget.throttle, trim: this.exerciseRun ? target.trim : manualTarget.trim,
      };
      this.state = stepFlight(this.state, this.controls, undefined, this.environment);
      this.accumulator -= dt;
      if (this.exerciseRun) {
        this.exerciseRun.advance(dt);
        this.exerciseState = this.exerciseRun.snapshot();
      }
      if (this.state.status !== 'FLYING') {
        if (this.exerciseRun) this.finishExercise('TERMINAL', this.state.status);
        else { this.paused = true; this.releasePhysicalOwnership(); }
        this.accumulator = 0;
        break;
      }
      if (this.exerciseRun?.complete) {
        this.exerciseState = this.exerciseRun.snapshot('COMPLETED');
        this.exerciseRun = null;
        this.paused = true;
        this.releasePhysicalOwnership();
        this.accumulator = 0;
        break;
      }
    }
  }
  instruments() { return flightInstruments(this.state, this.controls, undefined, this.environment); }

  private cancelExercise(): void {
    if (!this.exerciseRun) return;
    this.exerciseState = this.exerciseRun.snapshot('CANCELLED');
    this.exerciseRun = null;
    this.releasePhysicalOwnership();
  }
  private finishExercise(phase: 'TERMINAL', terminalStatus: FlightState['status']): void {
    if (!this.exerciseRun) return;
    this.exerciseState = this.exerciseRun.snapshot(phase, terminalStatus);
    this.exerciseRun = null;
    this.paused = true;
    this.releasePhysicalOwnership();
  }
  private releasePhysicalOwnership(): void {
    this.keys.clear();
    this.pointers.clear();
    this.controls = { ...this.controls, ...this.manualControls, pitch: 0, roll: 0, yaw: 0 };
  }
}

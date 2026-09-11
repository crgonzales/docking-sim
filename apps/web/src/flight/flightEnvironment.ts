import type { CharacterSession } from '../character/characterSession';
import type { FlightSession } from './flightSession';

/**
 * Render-side environment time for FLIGHT.
 *
 * This clock is deliberately independent from FlightSession's dynamics clock.
 * It uses the flight chart's explicit local solar time, not the host timezone
 * or wall clock, and exposes immutable render state so consumers cannot share
 * mutable Three.js vectors with the static scene.
 */

export const ENVIRONMENT_DAY_SECONDS = 86_400;
export const ENVIRONMENT_START_TIME_SECONDS = 10 * 60 * 60;
export const ENVIRONMENT_DEFAULT_TIME_SCALE = 1;
export const ENVIRONMENT_MAX_FRAME_DELTA_SECONDS = 0.1;
export const ENVIRONMENT_DEFAULT_LOCAL_LONGITUDE_DEG = 0;
export const ENVIRONMENT_TIME_SCALES = [0.25, 1, 10, 60] as const;

const TAU = 2 * Math.PI;
const MAX_TIME_SCALE = 240;
const SUNRISE_TWILIGHT_SIN = -0.12;
const SUNSET_DIRECT_SIN = 0.08;

export type EnvironmentTimeScale = (typeof ENVIRONMENT_TIME_SCALES)[number] | number;

/** Immutable render state shared by the flight scene, Earth and composer. */
export interface FlightEnvironmentRenderState {
  /** Continuous simulation time; does not wrap at midnight. */
  readonly timeSeconds: number;
  readonly timeOfDaySeconds: number;
  readonly localSolarTimeHours: number;
  readonly timeScale: number;
  readonly paused: boolean;
  /** Render/Hill frame direction from the surface toward the sun. */
  readonly sunDirection: readonly [number, number, number];
  /** Sine of local solar elevation at the chart origin. */
  readonly sunElevationSin: number;
  /** Positive-altitude cutoff used by direct daylight. */
  readonly daylight: boolean;
  /** Smooth direct-light factor; exactly zero at or below the horizon. */
  readonly directLightFactor: number;
  /** Bounded ambient/background factor retained through twilight/night. */
  readonly ambientLightFactor: number;
  /** Changes on every published state, including active clock ticks. */
  readonly revision: number;
  /** Changes only for reset/seek discontinuities. */
  readonly discontinuityRevision: number;
}

export interface FlightEnvironmentSource {
  readonly state: FlightEnvironmentRenderState;
}

export interface FlightEnvironmentOptions {
  readonly startTimeSeconds?: number;
  readonly timeScale?: number;
  readonly paused?: boolean;
  /** Positive longitude advances local solar time explicitly. */
  readonly localLongitudeDeg?: number;
}

type EnvironmentListener = () => void;

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

function normalizeDaySeconds(value: number): number {
  const wrapped = finite(value, 'Environment time') % ENVIRONMENT_DAY_SECONDS;
  return wrapped < 0 ? wrapped + ENVIRONMENT_DAY_SECONDS : wrapped;
}

function validateTimeScale(value: number): number {
  finite(value, 'Environment time scale');
  if (!(value > 0) || value > MAX_TIME_SCALE) {
    throw new RangeError(`Environment time scale must be in (0, ${MAX_TIME_SCALE}]`);
  }
  return value;
}

function validatePaused(value: boolean): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Environment paused state must be boolean');
  return value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function nextRevision(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? 0 : value + 1;
}

function solarState(
  timeSeconds: number,
  timeScale: number,
  paused: boolean,
  localLongitudeDeg: number,
  revision: number,
  discontinuityRevision: number,
): FlightEnvironmentRenderState {
  const timeOfDaySeconds = normalizeDaySeconds(timeSeconds);
  const localSolarTimeHours = ((timeOfDaySeconds / 3600 + localLongitudeDeg / 15) % 24 + 24) % 24;
  const hourAngle = (timeOfDaySeconds / 3600 - 12) * TAU / 24;
  // Equinox at the chart origin: +x is radial up, +y is world north and +z
  // is west in the render frame. The sun therefore completes one rotation
  // around the fixed world-north axis (+y) every 24 environment hours.
  const sunDirection: readonly [number, number, number] = Object.freeze([
    Math.cos(hourAngle),
    0,
    Math.sin(hourAngle),
  ]);
  const sunElevationSin = Math.cos((localSolarTimeHours - 12) * TAU / 24);
  const daylight = sunElevationSin > 0;
  const directLightFactor = daylight ? smoothstep(0, SUNSET_DIRECT_SIN, sunElevationSin) : 0;
  const ambientLightFactor = 0.12 + 0.88 * smoothstep(SUNRISE_TWILIGHT_SIN, SUNSET_DIRECT_SIN, sunElevationSin);
  return Object.freeze({
    timeSeconds,
    timeOfDaySeconds,
    localSolarTimeHours,
    timeScale,
    paused,
    sunDirection,
    sunElevationSin,
    daylight,
    directLightFactor,
    ambientLightFactor,
    revision,
    discontinuityRevision,
  });
}

/** Caller-owned, finite, midnight-continuous environment clock. */
export class FlightEnvironmentClock implements FlightEnvironmentSource {
  private timeSeconds: number;
  private readonly startTimeSeconds: number;
  private uiElapsed = 0;
  private uiState: FlightEnvironmentRenderState;
  private timeScaleValue: number;
  private pausedValue: boolean;
  private readonly localLongitudeDeg: number;
  private revisionValue = 0;
  private discontinuityRevisionValue = 0;
  private renderState: FlightEnvironmentRenderState;
  private readonly listeners = new Set<EnvironmentListener>();

  constructor(options: FlightEnvironmentOptions = {}) {
    this.timeScaleValue = validateTimeScale(options.timeScale ?? ENVIRONMENT_DEFAULT_TIME_SCALE);
    this.pausedValue = validatePaused(options.paused ?? false);
    this.localLongitudeDeg = finite(
      options.localLongitudeDeg ?? ENVIRONMENT_DEFAULT_LOCAL_LONGITUDE_DEG,
      'Environment local longitude',
    );
    if (this.localLongitudeDeg < -180 || this.localLongitudeDeg > 180) {
      throw new RangeError('Environment local longitude must be in [-180, 180] degrees');
    }
    // The stored clock phase is adjusted so the configured start is always
    // the requested local-solar hour, regardless of the explicit longitude.
    this.startTimeSeconds = normalizeDaySeconds(
      (options.startTimeSeconds ?? ENVIRONMENT_START_TIME_SECONDS) - this.localLongitudeDeg * 240,
    );
    this.timeSeconds = this.startTimeSeconds;
    this.renderState = solarState(
      this.timeSeconds,
      this.timeScaleValue,
      this.pausedValue,
      this.localLongitudeDeg,
      this.revisionValue,
      this.discontinuityRevisionValue,
    );
    this.uiState = this.renderState;
  }

  get state(): FlightEnvironmentRenderState { return this.renderState; }

  /** Stable identity is required by useSyncExternalStore and render owners. */
  readonly getSnapshot = (): FlightEnvironmentRenderState => this.uiState;

  readonly subscribe = (listener: EnvironmentListener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setPaused(paused: boolean): void {
    const next = validatePaused(paused);
    if (next === this.pausedValue) return;
    this.pausedValue = next;
    this.publish(false);
  }

  loseFocus(): void {
    this.setPaused(true);
  }

  setTimeScale(timeScale: number): void {
    const next = validateTimeScale(timeScale);
    if (next === this.timeScaleValue) return;
    this.timeScaleValue = next;
    this.publish(false);
  }

  /** Seek within the repeating local-solar day without waking the clock. */
  seekTimeOfDay(seconds: number): void {
    const next = normalizeDaySeconds(seconds - this.localLongitudeDeg * 240);
    if (next === normalizeDaySeconds(this.timeSeconds)) return;
    this.timeSeconds = Math.floor(this.timeSeconds / ENVIRONMENT_DAY_SECONDS) * ENVIRONMENT_DAY_SECONDS + next;
    this.publish(true);
  }

  seekLocalSolarHours(hours: number): void {
    finite(hours, 'Environment local solar hours');
    this.seekTimeOfDay(hours * 3600);
  }

  /** Restore the configured start time; pause state is preserved by default. */
  reset(paused = this.pausedValue): void {
    const nextPaused = validatePaused(paused);
    this.timeSeconds = this.startTimeSeconds;
    this.pausedValue = nextPaused;
    this.publish(true);
  }

  /**
   * Advance from bounded active frame time. Clamp BEFORE scaling so preview
   * speed stays identical at 30 and 144 FPS. FlightSession never receives
   * this scale; paused settling frames never advance it.
   */
  advance(frameDeltaSeconds: number): number {
    finite(frameDeltaSeconds, 'Environment frame delta');
    if (frameDeltaSeconds < 0) throw new RangeError('Environment frame delta must be non-negative');
    if (this.pausedValue || frameDeltaSeconds === 0) return 0;
    const acceptedFrameDelta = Math.min(frameDeltaSeconds, ENVIRONMENT_MAX_FRAME_DELTA_SECONDS);
    const acceptedEnvironmentDelta = acceptedFrameDelta * this.timeScaleValue;
    this.timeSeconds += acceptedEnvironmentDelta;
    this.uiElapsed += acceptedFrameDelta;
    this.publish(false, this.uiElapsed >= 0.1);
    return acceptedEnvironmentDelta;
  }

  private publish(discontinuity: boolean, notifyUi = true): void {
    this.revisionValue = nextRevision(this.revisionValue);
    if (discontinuity) this.discontinuityRevisionValue = nextRevision(this.discontinuityRevisionValue);
    this.renderState = solarState(
      this.timeSeconds,
      this.timeScaleValue,
      this.pausedValue,
      this.localLongitudeDeg,
      this.revisionValue,
      this.discontinuityRevisionValue,
    );
    if (notifyUi) {
      this.uiElapsed = 0;
      this.uiState = this.renderState;
      this.listeners.forEach((listener) => listener());
    }
  }
}

export function formatEnvironmentTime(seconds: number): string {
  const time = normalizeDaySeconds(seconds);
  const wholeSeconds = Math.floor(time);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secondsPart = wholeSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secondsPart).padStart(2, '0')}`;
}

export function environmentTimeInputValue(seconds: number): string {
  const time = normalizeDaySeconds(seconds);
  const wholeMinutes = Math.floor(time / 60);
  return `${String(Math.floor(wholeMinutes / 60)).padStart(2, '0')}:${String(wholeMinutes % 60).padStart(2, '0')}`;
}

export function environmentSecondsFromInput(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 3600 + minutes * 60;
}

/** Airborne character resets already call flight.reset; ground resets do not. */
export function subscribeEnvironmentToFlightReset(
  environment: FlightEnvironmentClock,
  flight: FlightSession,
  character: CharacterSession | null,
  onReset: () => void,
): () => void {
  const source = character?.start === 'GROUND' ? character : flight;
  return source.onReset(() => {
    environment.reset(character?.paused ?? flight.paused);
    onReset();
  });
}

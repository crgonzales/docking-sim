import {
  conjugateQuaternion,
  rotateVector,
  type Vec3,
} from '@docking/sim-core';
import { FlightSession, FLIGHT_KEYS } from '../flight/flightSession';
import { flightWorldFrame } from '../flight/flightFrame';
import { PARKED_HORNET_CLEARANCE_M } from '../flight/hornetPresentation';
import {
  createGroundSampler,
  sampleStableGround,
  type GroundSampler,
  type TerrainSourceRef,
} from './characterGround';
import {
  characterCameraPose,
  clampCharacterPitch,
  CHARACTER_EYE_HEIGHT_M,
  type CharacterCameraPose,
  wrapCharacterYaw,
} from './characterView';
import { EARTH_RADIUS_M } from '../scene/sky/skyConfig';

export type CharacterMode = 'VEHICLE' | 'ON_FOOT';
export type CharacterEquipment = 'EMPTY' | 'TOOL' | 'WEAPON';
export type CharacterStart = 'AIRBORNE' | 'GROUND';

export const CHARACTER_FIXED_DT_S = 0.01;
export const CHARACTER_MAX_FRAME_DELTA_S = 0.1;
const CHARACTER_GROUND_REFRESH_INTERVAL_S = 0.1;
export const CHARACTER_WALK_SPEED_MPS = 3;
export const CHARACTER_RUN_SPEED_MPS = 6;
export const CHARACTER_LOOK_SPEED_RAD_S = 1.8;
export const CHARACTER_MAX_DISTANCE_M = 150;
export const CHARACTER_BOARDING_DISTANCE_M = 12;
export const CHARACTER_EXIT_OFFSET_M = 8;
export const CHARACTER_AIRCRAFT_CLEARANCE_M = PARKED_HORNET_CLEARANCE_M;
export const CHARACTER_MAX_STEP_M = 0.75;
export const CHARACTER_MAX_SLOPE_RAD = 35 * Math.PI / 180;
export const CHARACTER_MAX_EXIT_GROUND_DELTA_M = 2;
export const CHARACTER_MAX_EXIT_ALTITUDE_M = 4;
export const CHARACTER_MIN_EXIT_ALTITUDE_M = 1;
export const CHARACTER_MAX_AIRSPEED_MPS = 1;
export const CHARACTER_MAX_BODY_RATE_RAD_S = 0.1;
export const CHARACTER_MAX_LEVEL_ATTITUDE_RAD = 15 * Math.PI / 180;
export const GROUND_FIXTURE_LAT_DEG = 7;
export const GROUND_FIXTURE_LON_DEG = 0.02;

const GROUND_FIXTURE_N_M = GROUND_FIXTURE_LAT_DEG * Math.PI / 180 * EARTH_RADIUS_M;
const GROUND_FIXTURE_E_M = GROUND_FIXTURE_LON_DEG * Math.PI / 180 * EARTH_RADIUS_M;
const GROUND_WAIT_ALTITUDE_M = 1000;
const IDENTITY_QUATERNION: [number, number, number, number] = [1, 0, 0, 0];

export interface CharacterRouteOptions {
  readonly enabled: boolean;
  readonly start: CharacterStart;
}

export type CharacterSearch = string | URLSearchParams;

export function characterRouteFromSearch(search?: CharacterSearch): CharacterRouteOptions {
  const query = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(search ?? (typeof window === 'undefined' ? '' : window.location.search));
  const explicitCharacter = query.get('character');
  const explicitAirborne = query.get('start') === 'airborne';
  const enabled = explicitCharacter === '1'
    || (explicitCharacter !== '0' && !explicitAirborne);
  return {
    enabled,
    start: enabled && !explicitAirborne ? 'GROUND' : 'AIRBORNE',
  };
}

export const parseCharacterRoute = characterRouteFromSearch;
export const isCharacterEnabled = (search?: CharacterSearch): boolean => characterRouteFromSearch(search).enabled;

export interface CharacterSessionOptions {
  readonly flight?: FlightSession;
  readonly groundSampler?: GroundSampler;
  readonly terrainSourceRef?: TerrainSourceRef;
  readonly start?: CharacterStart;
  readonly search?: CharacterSearch;
  readonly fixtureAnchor_N_m?: Vec3;
  readonly initialYawRad?: number;
  readonly spawnSideOffsetM?: number;
  readonly maxDistanceM?: number;
}

export interface CharacterInteractionResult {
  readonly kind: 'NONE' | 'EXITED' | 'BOARDED' | 'REJECTED';
  readonly message: string;
}

export interface CharacterSessionState {
  readonly mode: CharacterMode;
  readonly equipment: CharacterEquipment;
  readonly paused: boolean;
  readonly groundReady: boolean;
  readonly position_N_m: Vec3;
  readonly yaw_rad: number;
  readonly pitch_rad: number;
  readonly interaction: CharacterInteractionResult;
}

const NONE_INTERACTION: CharacterInteractionResult = { kind: 'NONE', message: '' };

function horizontalDistance(first: Vec3, second: Vec3): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

function distance3D(first: Vec3, second: Vec3): number {
  const a = flightWorldFrame(first).position, b = flightWorldFrame(second).position;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function isWalkableTransition(fromHeightM: number, toHeightM: number, distanceM: number): boolean {
  if (!Number.isFinite(fromHeightM) || !Number.isFinite(toHeightM) || !Number.isFinite(distanceM) || distanceM <= 0) return false;
  const rise = Math.abs(toHeightM - fromHeightM);
  return rise <= CHARACTER_MAX_STEP_M && Math.atan2(rise, distanceM) <= CHARACTER_MAX_SLOPE_RAD;
}

/** Coordinator for the opt-in vehicle/on-foot state machine. */
export class CharacterSession {
  private readonly resetListeners = new Set<() => void>();
  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener);
    return () => { this.resetListeners.delete(listener); };
  }
  readonly flight: FlightSession;
  readonly start: CharacterStart;
  private readonly groundSampler: GroundSampler;
  private readonly fixtureAnchor_N_m: Vec3;
  private readonly initialYawRad: number;
  private readonly spawnSideOffsetM: number;
  private readonly maxDistanceM: number;
  private readonly initialDownM: number;
  private readonly keys = new Set<string>();
  private readonly releaseListeners = new Set<() => void>();
  private accumulator = 0;
  private groundRefreshAccumulator = 0;
  private _mode: CharacterMode;
  private _equipment: CharacterEquipment = 'EMPTY';
  private _paused = false;
  private _groundReady = false;
  private _position_N_m: Vec3;
  private _yaw_rad = 0;
  private _pitch_rad = 0;
  private fixtureGroundHeightM: number | null = null;
  private characterGroundHeightM: number | null = null;
  private flightFrozen: boolean;
  private _interaction: CharacterInteractionResult = NONE_INTERACTION;

  constructor(options: CharacterSessionOptions = {}) {
    this.flight = options.flight ?? new FlightSession();
    this.groundSampler = options.groundSampler
      ?? (options.terrainSourceRef === undefined ? () => null : createGroundSampler(options.terrainSourceRef));
    const route = options.search === undefined
      ? { enabled: false, start: 'AIRBORNE' as const }
      : characterRouteFromSearch(options.search);
    this.start = options.start ?? route.start;
    const anchor = options.fixtureAnchor_N_m ?? [GROUND_FIXTURE_N_M, GROUND_FIXTURE_E_M, 0];
    if (anchor.length !== 3 || !anchor.every((value) => Number.isFinite(value))) throw new RangeError('Character fixture anchor must be finite');
    this.fixtureAnchor_N_m = [...anchor];
    this.initialYawRad = wrapCharacterYaw(options.initialYawRad ?? 0);
    this.spawnSideOffsetM = options.spawnSideOffsetM ?? CHARACTER_EXIT_OFFSET_M;
    if (!Number.isFinite(this.spawnSideOffsetM) || this.spawnSideOffsetM <= 0) throw new RangeError('Character spawn offset must be positive and finite');
    this.maxDistanceM = options.maxDistanceM ?? CHARACTER_MAX_DISTANCE_M;
    if (!Number.isFinite(this.maxDistanceM) || this.maxDistanceM <= 0) throw new RangeError('Character maximum distance must be positive and finite');
    this.initialDownM = options.fixtureAnchor_N_m === undefined ? -GROUND_WAIT_ALTITUDE_M : this.fixtureAnchor_N_m[2];
    this._position_N_m = [this.fixtureAnchor_N_m[0], this.fixtureAnchor_N_m[1] + this.spawnSideOffsetM, this.initialDownM];
    this._yaw_rad = this.initialYawRad;
    this._paused = this.start === 'AIRBORNE' && this.flight.paused;
    this._mode = this.start === 'GROUND' ? 'ON_FOOT' : 'VEHICLE';
    this.flightFrozen = this.start === 'GROUND';
    if (this.start === 'GROUND') {
      this.configureParkedAircraft(null, true);
      this.refreshTerrain();
    }
  }

  get mode(): CharacterMode { return this._mode; }
  get equipment(): CharacterEquipment { return this._equipment; }
  get paused(): boolean { return this._paused; }
  get groundReady(): boolean { return this._groundReady; }
  get parked(): boolean { return this.flightFrozen; }
  get position_N_m(): Vec3 { return [...this._position_N_m]; }
  get yaw_rad(): number { return this._yaw_rad; }
  get pitch_rad(): number { return this._pitch_rad; }
  get interaction(): CharacterInteractionResult { return this._interaction; }
  get interactionResult(): CharacterInteractionResult { return this._interaction; }
  get camera(): CharacterCameraPose {
    return characterCameraPose(this._position_N_m, this._yaw_rad, this._pitch_rad, CHARACTER_EYE_HEIGHT_M);
  }
  get state(): CharacterSessionState {
    return {
      mode: this._mode,
      equipment: this._equipment,
      paused: this._paused,
      groundReady: this._groundReady,
      position_N_m: [...this._position_N_m],
      yaw_rad: this._yaw_rad,
      pitch_rad: this._pitch_rad,
      interaction: this._interaction,
    };
  }

  /** Clear both owners' holds and discard partial fixed-step time. */
  releaseControls(): void {
    this.keys.clear();
    this.accumulator = 0;
    this.flight.releaseControls();
    this.releaseListeners.forEach((listener) => listener());
  }

  /** The DOM adapter releases pointer lock for every transition, including HUD actions. */
  onControlsReleased(listener: () => void): () => void {
    this.releaseListeners.add(listener);
    return () => { this.releaseListeners.delete(listener); };
  }

  togglePause(): void {
    this._paused = !this._paused;
    this.releaseControls();
    if (!this._paused && this.flightFrozen) this.groundRefreshAccumulator = CHARACTER_GROUND_REFRESH_INTERVAL_S;
    if (this._mode === 'VEHICLE' && !this.flightFrozen) this.flight.paused = this._paused;
  }

  loseFocus(): void {
    this._paused = true;
    this.releaseControls();
    if (this._mode === 'VEHICLE' && !this.flightFrozen) this.flight.paused = true;
  }

  reset(): void {
    this.releaseControls();
    this._paused = false;
    this._equipment = 'EMPTY';
    this._yaw_rad = 0;
    this._pitch_rad = 0;
    this._interaction = NONE_INTERACTION;
    this.fixtureGroundHeightM = null;
    this.characterGroundHeightM = null;
    if (this.start === 'GROUND') {
      this._mode = 'ON_FOOT';
      this.flightFrozen = true;
      this._groundReady = false;
      this._position_N_m = [this.fixtureAnchor_N_m[0], this.fixtureAnchor_N_m[1] + this.spawnSideOffsetM, this.initialDownM];
      this._yaw_rad = this.initialYawRad;
      this.configureParkedAircraft(null, true);
      this.refreshTerrain();
      this.resetListeners.forEach((listener) => listener());
      return;
    }
    this.flight.reset();
    this.flightFrozen = false;
    this._mode = 'VEHICLE';
    this._groundReady = false;
    this.resetListeners.forEach((listener) => listener());
  }

  /** Apply finite mouse/adapter deltas in radians; ignored while not looking. */
  look(deltaYawRad: number, deltaPitchRad: number): boolean {
    if (!Number.isFinite(deltaYawRad) || !Number.isFinite(deltaPitchRad) || this._paused || this._mode !== 'ON_FOOT' || !this._groundReady) return false;
    this._yaw_rad = wrapCharacterYaw(this._yaw_rad + deltaYawRad);
    this._pitch_rad = clampCharacterPitch(this._pitch_rad + deltaPitchRad);
    return true;
  }

  /** Route a logical key without depending on DOM event ownership. */
  key(code: string, down: boolean): boolean {
    if (!down) {
      this.keys.delete(code);
      if (this._mode === 'VEHICLE' && FLIGHT_KEYS.has(code) && (!this.flightFrozen || code === 'KeyC')) this.flight.key(code, false);
      return false;
    }
    if (this.keys.has(code)) return false;
    this.keys.add(code);
    if (code === 'KeyP') { this.togglePause(); return true; }
    if (code === 'KeyR') { this.reset(); return true; }
    if (code === 'Escape') { this.loseFocus(); return true; }
    if (code === 'KeyF') { this.interact(); return true; }
    if (this._mode === 'VEHICLE' && FLIGHT_KEYS.has(code)) {
      if (this.flightFrozen && code !== 'KeyC') return false;
      this.flight.key(code, true);
      return code === 'KeyC';
    }
    if (this._mode !== 'ON_FOOT' || this._paused || !this._groundReady) return false;
    if (code === 'Digit1') { this._equipment = 'EMPTY'; return true; }
    if (code === 'Digit2') { this._equipment = 'TOOL'; return true; }
    if (code === 'Digit3') { this._equipment = 'WEAPON'; return true; }
    return false;
  }

  interact(): CharacterInteractionResult {
    if (this._paused) return this.rejectInteraction('INTERACTION BLOCKED · P TO RESUME');
    if (this._mode === 'VEHICLE') return this.tryExit();
    return this.tryBoard();
  }

  /** Advance flight or character ownership, never both. */
  advance(delta_s: number): void {
    if (!Number.isFinite(delta_s) || delta_s < 0) return;
    if (this._paused) { this.accumulator = 0; return; }
    if (this.flightFrozen) {
      this.groundRefreshAccumulator += Math.min(delta_s, CHARACTER_MAX_FRAME_DELTA_S);
      if (delta_s === 0 || !this._groundReady || this.groundRefreshAccumulator + 1e-10 >= CHARACTER_GROUND_REFRESH_INTERVAL_S) {
        this.refreshTerrain();
        this.groundRefreshAccumulator = 0;
      }
    }
    if (this._mode === 'VEHICLE') {
      if (this.flightFrozen) return;
      this.flight.advance(delta_s);
      if (this.flight.paused || this.flight.state.status !== 'FLYING') this.loseFocus();
      return;
    }
    if (!this._groundReady) { this.releaseControls(); return; }
    this.accumulator += Math.min(delta_s, CHARACTER_MAX_FRAME_DELTA_S);
    while (this.accumulator + 1e-10 >= CHARACTER_FIXED_DT_S) {
      this.stepCharacter(CHARACTER_FIXED_DT_S);
      this.accumulator -= CHARACTER_FIXED_DT_S;
    }
  }

  private refreshTerrain(): void {
    const aircraftPosition = this.flight.state.position_N_m;
    const aircraftGround = this.groundSampler([...aircraftPosition]);
    if (aircraftGround !== null && Number.isFinite(aircraftGround) && aircraftGround > 0) {
      this.fixtureGroundHeightM = aircraftGround;
      if (this.flightFrozen) this.configureParkedAircraft(aircraftGround, false);
    } else {
      this.fixtureGroundHeightM = null;
    }
    const characterGround = this.groundSampler([...this._position_N_m]);
    if (characterGround !== null && Number.isFinite(characterGround) && characterGround > 0) {
      this.characterGroundHeightM = characterGround;
      this._position_N_m = [this._position_N_m[0], this._position_N_m[1], -characterGround];
    } else {
      this.characterGroundHeightM = null;
    }
    this._groundReady = this.fixtureGroundHeightM !== null && this.characterGroundHeightM !== null;
  }

  private stepCharacter(dt: number): void {
    if (this.characterGroundHeightM === null) return;
    const left = this.keys.has('KeyA') ? 1 : 0;
    const right = this.keys.has('KeyD') ? 1 : 0;
    const forward = this.keys.has('KeyW') ? 1 : 0;
    const backward = this.keys.has('KeyS') ? 1 : 0;
    const lookYaw = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
    const lookPitch = (this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0);
    if (lookYaw !== 0 || lookPitch !== 0) this.look(lookYaw * CHARACTER_LOOK_SPEED_RAD_S * dt, lookPitch * CHARACTER_LOOK_SPEED_RAD_S * dt);
    const north = forward - backward;
    const east = right - left;
    const magnitude = Math.hypot(north, east);
    if (magnitude === 0) return;
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? CHARACTER_RUN_SPEED_MPS : CHARACTER_WALK_SPEED_MPS;
    const directionNorth = (north * Math.cos(this._yaw_rad) - east * Math.sin(this._yaw_rad)) / magnitude;
    const directionEast = (north * Math.sin(this._yaw_rad) + east * Math.cos(this._yaw_rad)) / magnitude;
    const distanceM = speed * dt;
    const candidate_N_m: Vec3 = [
      this._position_N_m[0] + directionNorth * distanceM,
      this._position_N_m[1] + directionEast * distanceM,
      this._position_N_m[2],
    ];
    const aircraftPosition = this.flight.state.position_N_m;
    if (horizontalDistance(candidate_N_m, aircraftPosition) > this.maxDistanceM) return;
    const candidateGround = this.groundSampler([...candidate_N_m]);
    if (candidateGround === null || !Number.isFinite(candidateGround) || candidateGround <= 0
      || !isWalkableTransition(this.characterGroundHeightM, candidateGround, distanceM)) return;
    this.characterGroundHeightM = candidateGround;
    this._position_N_m = [candidate_N_m[0], candidate_N_m[1], -candidateGround];
  }

  private tryExit(): CharacterInteractionResult {
    const state = this.flight.state;
    if (state.status !== 'FLYING') return this.rejectInteraction('EXIT REJECTED · FLIGHT STATUS IS TERMINAL');
    const flightValues = [
      ...state.position_N_m, ...state.velocity_N_m_s, ...state.q_BN, ...state.omega_B_rad_s,
      state.engine, state.time_s, ...Object.values(this.flight.controls),
    ];
    if (!flightValues.every(Number.isFinite)) {
      return this.rejectInteraction('EXIT REJECTED · AIRCRAFT STATE IS NOT FINITE');
    }
    const aircraftGround = this.groundSampler([...state.position_N_m]);
    if (aircraftGround === null || !Number.isFinite(aircraftGround) || aircraftGround <= 0) {
      return this.rejectInteraction('EXIT REJECTED · LAND DATA UNAVAILABLE OR WATER');
    }
    const aircraftHeight = -state.position_N_m[2] - aircraftGround;
    if (aircraftHeight < CHARACTER_MIN_EXIT_ALTITUDE_M || aircraftHeight > CHARACTER_MAX_EXIT_ALTITUDE_M) {
      return this.rejectInteraction('EXIT REJECTED · AIRCRAFT MUST BE 1–4 M ABOVE LAND');
    }
    if (Math.hypot(...state.velocity_N_m_s) > CHARACTER_MAX_AIRSPEED_MPS) return this.rejectInteraction('EXIT REJECTED · AIRCRAFT SPEED MUST BE ≤ 1 M/S');
    if (Math.hypot(...state.omega_B_rad_s) > CHARACTER_MAX_BODY_RATE_RAD_S) return this.rejectInteraction('EXIT REJECTED · AIRCRAFT BODY RATES MUST BE ≤ 0.1 RAD/S');
    let instruments: ReturnType<FlightSession['instruments']>;
    try {
      instruments = this.flight.instruments();
    } catch {
      return this.rejectInteraction('EXIT REJECTED · AIRCRAFT ATTITUDE IS INVALID');
    }
    if (!Number.isFinite(instruments.pitch_rad) || !Number.isFinite(instruments.bank_rad)
      || Math.abs(instruments.pitch_rad) > CHARACTER_MAX_LEVEL_ATTITUDE_RAD || Math.abs(instruments.bank_rad) > CHARACTER_MAX_LEVEL_ATTITUDE_RAD) {
      return this.rejectInteraction('EXIT REJECTED · AIRCRAFT MUST BE REASONABLY LEVEL');
    }
    const bodyRight_NED = rotateVector(conjugateQuaternion(state.q_BN), [0, 1, 0]);
    const horizontalRight = Math.hypot(bodyRight_NED[0], bodyRight_NED[1]);
    if (!Number.isFinite(horizontalRight) || horizontalRight < 1e-6) return this.rejectInteraction('EXIT REJECTED · NO VALID WING-SIDE EXIT');
    const exitPosition_N_m: Vec3 = [
      state.position_N_m[0] + bodyRight_NED[0] / horizontalRight * CHARACTER_EXIT_OFFSET_M,
      state.position_N_m[1] + bodyRight_NED[1] / horizontalRight * CHARACTER_EXIT_OFFSET_M,
      state.position_N_m[2],
    ];
    const exitGround = sampleStableGround(this.groundSampler, exitPosition_N_m);
    const aircraftStableGround = sampleStableGround(this.groundSampler, [...state.position_N_m]);
    if (exitGround === null || aircraftStableGround === null) return this.rejectInteraction('EXIT REJECTED · GROUND IS NOT STABLE AT AIRCRAFT AND EXIT');
    if (Math.abs(exitGround - aircraftStableGround) > CHARACTER_MAX_EXIT_GROUND_DELTA_M) return this.rejectInteraction('EXIT REJECTED · EXIT GROUND IS TOO UNEVEN');
    this.parkAircraft();
    this._mode = 'ON_FOOT';
    this.flightFrozen = true;
    this._position_N_m = [exitPosition_N_m[0], exitPosition_N_m[1], -exitGround];
    this.characterGroundHeightM = exitGround;
    this.fixtureGroundHeightM = aircraftStableGround;
    this._groundReady = true;
    this._equipment = 'EMPTY';
    this.releaseControls();
    return this.setInteraction('EXITED', 'EXITED AIRCRAFT · F TO BOARD');
  }

  private tryBoard(): CharacterInteractionResult {
    if (!this._groundReady) return this.rejectInteraction('BOARDING BLOCKED · WAITING FOR STABLE LAND');
    const aircraft = this.flight.state.position_N_m;
    const character = this._position_N_m;
    if (![...aircraft, ...character].every(Number.isFinite)) return this.rejectInteraction('BOARDING REJECTED · AIRCRAFT OR CHARACTER STATE IS NOT FINITE');
    if (distance3D(character, aircraft) > CHARACTER_BOARDING_DISTANCE_M) return this.rejectInteraction('BOARDING REJECTED · MOVE WITHIN 12 M OF AIRCRAFT');
    const characterGround = sampleStableGround(this.groundSampler, [...character]);
    const aircraftGround = sampleStableGround(this.groundSampler, [...aircraft]);
    if (characterGround === null || aircraftGround === null) return this.rejectInteraction('BOARDING REJECTED · GROUND IS NOT STABLE AT BOTH POSES');
    if (Math.abs(-character[2] - characterGround) > CHARACTER_MAX_STEP_M
      || -aircraft[2] - aircraftGround < CHARACTER_MIN_EXIT_ALTITUDE_M
      || -aircraft[2] - aircraftGround > CHARACTER_MAX_EXIT_ALTITUDE_M) {
      return this.rejectInteraction('BOARDING REJECTED · WAIT FOR GROUND ALIGNMENT');
    }
    this._mode = 'VEHICLE';
    this._equipment = 'EMPTY';
    this._groundReady = true;
    this.releaseControls();
    this.flight.paused = true;
    return this.setInteraction('BOARDED', 'BOARDED PARKED AIRCRAFT · NO TAKEOFF');
  }

  private configureParkedAircraft(groundHeightM: number | null, resetPose: boolean): void {
    this.flight.park();
    const position_N_m: Vec3 = [
      resetPose ? this.fixtureAnchor_N_m[0] : this.flight.state.position_N_m[0],
      resetPose ? this.fixtureAnchor_N_m[1] : this.flight.state.position_N_m[1],
      groundHeightM === null ? -GROUND_WAIT_ALTITUDE_M : -(groundHeightM + CHARACTER_AIRCRAFT_CLEARANCE_M),
    ];
    const state = this.flight.state;
    this.flight.state = {
      ...state,
      time_s: resetPose ? 0 : state.time_s,
      position_N_m,
      velocity_N_m_s: [0, 0, 0],
      q_BN: resetPose ? [...IDENTITY_QUATERNION] : [...state.q_BN],
      omega_B_rad_s: [0, 0, 0],
      engine: 0,
      status: 'FLYING',
    };
    this.flight.paused = true;
  }

  private parkAircraft(): void {
    this.flight.park();
    const state = this.flight.state;
    this.flight.state = {
      ...state,
      velocity_N_m_s: [0, 0, 0],
      omega_B_rad_s: [0, 0, 0],
      engine: 0,
      status: 'FLYING',
    };
    this.flight.paused = true;
  }

  private setInteraction(kind: CharacterInteractionResult['kind'], message: string): CharacterInteractionResult {
    this._interaction = { kind, message };
    return this._interaction;
  }

  private rejectInteraction(message: string): CharacterInteractionResult {
    return this.setInteraction('REJECTED', message);
  }
}

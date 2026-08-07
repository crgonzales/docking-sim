import type {
  SensorDegradeConfig,
  SimLoop,
  TelemetryFrame,
  Vec3,
} from '@docking/sim-core';
import type {
  Beat,
  ClearCondition,
  FailureInjection,
  PanelControlId,
  PlayerAction,
  Scenario,
  TelemetryCheck,
} from './schema.js';

/** The scenario boundary deliberately cannot access truth or render state. */
export type ScenarioSimPort = Omit<SimLoop, 'getTruthState' | 'getRenderState'>;

export type ScenarioPhase = 'BRIEFING' | 'RUNNING' | 'DEBRIEF';
export type ScenarioAlarm = 'MASTER' | 'CAUTION' | null;

export interface ScenarioCallout {
  beat_id: string;
  callout: string;
  hint_control: PanelControlId;
  alarm: Exclude<ScenarioAlarm, null> | null;
}

export interface ScenarioUiState {
  phase: ScenarioPhase;
  clock: { label: string; elapsed_s: number; remaining_s: number };
  active_callouts: ScenarioCallout[];
  hint_control: PanelControlId | null;
  alarm_level: ScenarioAlarm;
  outcome: Scenario['clock']['expiry_outcome'] | null;
  debrief_if_causal: string | null;
  telemetry: TelemetryFrame | null;
  score_inputs: {
    prop_kg: number | null;
    time_margin_s: number;
    corridor_violations: number;
  };
}

interface ActionRecord {
  action: PlayerAction;
  t_s: number;
}

interface BeatState {
  beat: Beat;
  fired: boolean;
  cleared: boolean;
  escalated: boolean;
  causal: boolean;
  actionMatched: boolean;
  belowSince_s: number | null;
}

const DEG_TO_RAD = Math.PI / 180;

function cloneVec3(value: Vec3): Vec3 {
  return [...value] as Vec3;
}

function cloneTelemetry(frame: TelemetryFrame | null): TelemetryFrame | null {
  if (frame === null) return null;
  return {
    ...frame,
    nav_r_hill_m: cloneVec3(frame.nav_r_hill_m),
    nav_cov_pos_m2: cloneVec3(frame.nav_cov_pos_m2),
    thruster_duty: { ...frame.thruster_duty },
    q_BH_est: [...frame.q_BH_est],
    body_rate_dps_est: cloneVec3(frame.body_rate_dps_est),
    docking: frame.docking === null ? null : { ...frame.docking },
  };
}

function actionsEqual(left: PlayerAction, right: PlayerAction): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'SET_NAV_SOURCE':
      return right.kind === left.kind && right.to === left.to;
    case 'ISOLATE_THRUSTER':
      return right.kind === left.kind && right.thruster_id === left.thruster_id;
    case 'SET_CONTROLLER':
      return right.kind === left.kind && right.to === left.to;
    case 'SET_CONTROL_MODE':
      return right.kind === left.kind && right.to === left.to;
  }
}

function telemetryValue(frame: TelemetryFrame, check: TelemetryCheck): number | null {
  switch (check.signal) {
    case 'NEES':
      return frame.nees;
    case 'CORRIDOR_ERR_M':
      return frame.corridor_err_m;
    case 'BODY_RATE_DPS':
      return frame.body_rate_dps;
    case 'RANGE_M':
      return frame.range_m;
  }
}

function telemetryCheckSatisfied(frame: TelemetryFrame | null, check: TelemetryCheck): boolean {
  const value = frame === null ? null : telemetryValue(frame, check);
  return value !== null && value < check.below;
}

function clearConditionHasTelemetry(condition: ClearCondition): condition is Extract<ClearCondition, { kind: 'ACTION_AND_TELEMETRY' | 'TELEMETRY' }> {
  return condition.kind === 'ACTION_AND_TELEMETRY' || condition.kind === 'TELEMETRY';
}

/** Compose a new sensor degradation onto whatever is already injected.
 *  `setSensorDegrade` holds a single config, so an escalation (e.g. B1's
 *  range NOISE_X10) must merge with — never replace — an active failure
 *  (B1's attitude bias ramp). The earliest start_t_s is preserved so
 *  continuous bias ramps keep their elapsed time. */
function mergeSensorDegrade(
  current: SensorDegradeConfig | null,
  next: SensorDegradeConfig,
): SensorDegradeConfig {
  if (current === null) return next;
  const merged: SensorDegradeConfig = { ...current, ...next, start_t_s: current.start_t_s };
  if (current.biasRamp !== undefined || next.biasRamp !== undefined) {
    merged.biasRamp = { ...current.biasRamp, ...next.biasRamp };
  }
  merged.dropout = next.dropout ?? current.dropout;
  return merged;
}

function sensorDegradeFor(injection: Extract<FailureInjection, { kind: 'NAV_DEGRADE' }>, t_s: number): SensorDegradeConfig {
  if (injection.mode === 'BIAS_RAMP') {
    const rate = (injection.params?.deg_per_min ?? 0) * DEG_TO_RAD;
    return injection.sensor === 'STAR_TRACKER'
      ? { start_t_s: t_s, biasRamp: { attitudeBiasRatePerMin_rad: [rate, rate, rate] } }
      : { start_t_s: t_s, biasRamp: { range_m: injection.params?.m_per_min ?? 0 } };
  }
  if (injection.mode === 'NOISE_X10') {
    return {
      start_t_s: t_s,
      channel: injection.sensor === 'RANGE' ? 'RANGE' : 'ATTITUDE',
      noiseMultiplier: 10,
    };
  }
  return {
    start_t_s: t_s,
    dropout: injection.sensor === 'RANGE' ? { range: true } : { attitude: true },
  };
}

function applyPlayerAction(port: ScenarioSimPort, action: PlayerAction): void {
  switch (action.kind) {
    case 'SET_NAV_SOURCE':
      port.setNavSource(action.to);
      return;
    case 'ISOLATE_THRUSTER':
      port.isolateThruster(action.thruster_id);
      return;
    case 'SET_CONTROLLER':
      port.setController(action.to);
      return;
    case 'SET_CONTROL_MODE':
      port.setControlMode(action.to);
      return;
  }
}

function latestOutcome(frame: TelemetryFrame | null): Scenario['clock']['expiry_outcome'] | null {
  if (frame === null) return null;
  switch (frame.outcome) {
    case 'DOCKED':
      return 'DOCKED';
    case 'COLLISION':
      return 'COLLISION';
    case 'ABORT':
      return 'PASSIVE_ABORT';
    case 'NONE':
      return null;
  }
}

/** Create the deterministic scenario state machine around a public SimLoop. */
export function createScenarioDirector(scenario: Scenario, simPort: ScenarioSimPort) {
  let phase: ScenarioPhase = 'BRIEFING';
  let clock_s = 0;
  let outcome: ScenarioUiState['outcome'] = null;
  let latestFrame: TelemetryFrame | null = null;
  let causalBeat: BeatState | null = null;
  let actionRecords: ActionRecord[] = [];
  let corridorViolations = 0;
  let previousCorridorLevel: TelemetryFrame['corridor_level'] | null = null;
  let activeSensorDegrade: SensorDegradeConfig | null = null;

  const applyInjection = (injection: FailureInjection, t_s: number): void => {
    switch (injection.kind) {
      case 'NONE':
        return;
      case 'NAV_DEGRADE':
        activeSensorDegrade = mergeSensorDegrade(activeSensorDegrade, sensorDegradeFor(injection, t_s));
        simPort.setSensorDegrade(activeSensorDegrade);
        return;
      case 'THRUSTER_STUCK':
        simPort.injectThrusterStuck(injection.thruster_id, injection.stuck);
        return;
      case 'GUIDANCE_FAULT':
        simPort.injectGuidanceFault();
        return;
      case 'VEL_BIAS':
        simPort.injectVelocityBias(cloneVec3(injection.dv_mps));
        return;
    }
  };
  const beats: BeatState[] = scenario.beats.map((beat) => ({
    beat,
    fired: false,
    cleared: false,
    escalated: false,
    causal: false,
    actionMatched: false,
    belowSince_s: null,
  }));

  const makeState = (): ScenarioUiState => {
    const active = beats
      .filter((state) => state.fired && !state.cleared)
      .map(({ beat }) => ({
        beat_id: beat.id,
        callout: beat.prompts.callout,
        hint_control: beat.prompts.hint_control,
        alarm: beat.prompts.alarm,
      }));
    const alarm_level: ScenarioAlarm = active.some((callout) => callout.alarm === 'MASTER')
      ? 'MASTER'
      : active.some((callout) => callout.alarm === 'CAUTION') ? 'CAUTION' : null;
    return {
      phase,
      clock: {
        label: scenario.clock.label,
        elapsed_s: clock_s,
        remaining_s: Math.max(0, scenario.clock.duration_s - clock_s),
      },
      active_callouts: active,
      hint_control: scenario.assist_default === 'GUIDED'
        ? active.at(-1)?.hint_control ?? null
        : null,
      alarm_level,
      outcome,
      debrief_if_causal: causalBeat?.beat.debrief_if_causal ?? null,
      telemetry: cloneTelemetry(latestFrame),
      score_inputs: {
        prop_kg: latestFrame?.prop_kg ?? null,
        time_margin_s: outcome === 'DOCKED' ? Math.max(0, scenario.clock.duration_s - clock_s) : 0,
        corridor_violations: corridorViolations,
      },
    };
  };

  const latchOutcome = (next: NonNullable<ScenarioUiState['outcome']>): void => {
    if (outcome !== null) return;
    outcome = next;
    phase = 'DEBRIEF';
  };

  // "Player flew too well" test for a NONE-trigger beat's guarantee. The full
  // clearSatisfied() can never be true at the fire instant (its hold-timer
  // only starts tracking after the beat fires), so the spec's "clears_when is
  // already satisfied at that instant" means the instantaneous telemetry
  // check — for B3: corridor error already inside the bound.
  const guaranteeConditionMet = (state: BeatState): boolean => {
    const condition = state.beat.clears_when;
    if (clearConditionHasTelemetry(condition)) return telemetryCheckSatisfied(latestFrame, condition.check);
    return actionSatisfied(state);
  };

  const fireDueBeats = (): void => {
    for (const state of beats) {
      if (state.fired || state.beat.t_start_s > clock_s) continue;
      state.fired = true;
      if (state.beat.trigger.kind === 'NONE') {
        if (state.beat.guarantee !== undefined && guaranteeConditionMet(state)) {
          applyInjection(state.beat.guarantee, clock_s);
        }
      } else {
        applyInjection(state.beat.trigger, clock_s);
      }
    }
  };

  const actionSatisfied = (state: BeatState): boolean => state.actionMatched;

  const clearSatisfied = (state: BeatState): boolean => {
    const condition = state.beat.clears_when;
    if (condition.kind === 'ACTION') return actionSatisfied(state);
    const telemetryReady = state.belowSince_s !== null && clock_s - state.belowSince_s >= condition.check.hold_s;
    return condition.kind === 'TELEMETRY'
      ? telemetryReady
      : state.actionMatched && telemetryReady;
  };

  const evaluateClears = (frames: readonly TelemetryFrame[]): void => {
    for (const frame of frames) {
      latestFrame = frame;
      if (previousCorridorLevel !== 'CAUTION' && frame.corridor_level === 'CAUTION') corridorViolations += 1;
      previousCorridorLevel = frame.corridor_level;
      for (const state of beats) {
        if (!state.fired || state.cleared) continue;
        if (clearConditionHasTelemetry(state.beat.clears_when)) {
          const below = telemetryCheckSatisfied(frame, state.beat.clears_when.check);
          state.belowSince_s = below ? state.belowSince_s ?? frame.t_s : null;
        }
        if (clearSatisfied(state)) state.cleared = true;
      }
    }
  };

  const evaluateClearsWithoutFrame = (): void => {
    for (const state of beats) {
      if (state.fired && !state.cleared && clearSatisfied(state)) state.cleared = true;
    }
  };

  const applyEscalations = (): void => {
    for (const state of beats) {
      if (!state.fired || state.cleared || state.escalated) continue;
      if (clock_s < state.beat.t_start_s + state.beat.response_window_s) continue;
      state.escalated = true;
      state.causal = true;
      causalBeat = state;
      if (state.beat.escalation !== undefined) applyInjection(state.beat.escalation.secondary, clock_s);
    }
  };

  const resolveOutcome = (expiryReached: boolean): void => {
    if (outcome !== null) return;
    const simOutcome = latestOutcome(latestFrame);
    if (simOutcome !== null) {
      latchOutcome(simOutcome);
      return;
    }
    if (latestFrame?.corridor_level === 'VIOLATION' && scenario.monitors.corridor_abort) {
      latchOutcome('PASSIVE_ABORT');
      return;
    }
    // DOCKED and COLLISION latch truth-side only (sim-core contact
    // evaluation, mapped via latestOutcome above). The director must never
    // declare capture from envelope telemetry alone — the PiP numbers can
    // sit inside the envelope seconds before actual contact.
    if (expiryReached) {
      // The retreat command is intentionally issued at T-0, before this
      // scenario-layer WINDOW_MISSED latch. A DOCKED frame above wins.
      simPort.commandAbort();
      latchOutcome(scenario.clock.expiry_outcome);
    }
  };

  const processAt = (target_s: number): void => {
    const frames = target_s > clock_s ? simPort.stepTo(target_s) : [];
    clock_s = target_s;
    const expiryReached = clock_s >= scenario.clock.duration_s;
    if (expiryReached && outcome === null) simPort.commandAbort();
    fireDueBeats();
    evaluateClears(frames);
    evaluateClearsWithoutFrame();
    applyEscalations();
    resolveOutcome(expiryReached);
  };

  const tick = (target_t_s: number): ScenarioUiState => {
    if (!Number.isFinite(target_t_s) || target_t_s < 0) throw new RangeError('scenario tick time must be finite and non-negative');
    if (phase !== 'RUNNING') return makeState();
    if (target_t_s < clock_s) throw new RangeError('scenario tick time must be non-decreasing');

    const target = Math.min(target_t_s, scenario.clock.duration_s);
    if (clock_s === target) processAt(target);
    while (phase === 'RUNNING' && clock_s < target) {
      const nextBeat = beats
        .filter((state) => !state.fired && state.beat.t_start_s > clock_s)
        .map((state) => state.beat.t_start_s)
        .reduce((earliest, time) => Math.min(earliest, time), target);
      const nextExpiry = beats
        .filter((state) => state.fired && !state.cleared && state.beat.t_start_s + state.beat.response_window_s > clock_s)
        .map((state) => state.beat.t_start_s + state.beat.response_window_s)
        .reduce((earliest, time) => Math.min(earliest, time), target);
      processAt(Math.min(target, nextBeat, nextExpiry));
    }
    return makeState();
  };

  // These three initial selections are command-surface state rather than
  // SimConfig fields. Apply them at construction so every caller gets the
  // scenario's declared starting mode, including headless callers.
  simPort.setController(scenario.initial.controller);
  simPort.setControlMode(scenario.initial.control_mode);
  simPort.setNavSource(scenario.initial.nav_source);

  return {
    launch(): ScenarioUiState {
      if (phase === 'BRIEFING') phase = 'RUNNING';
      return makeState();
    },
    tick,
    dispatchPlayerAction(action: PlayerAction): void {
      applyPlayerAction(simPort, action);
      actionRecords.push({ action, t_s: clock_s });
      for (const state of beats) {
        if (state.fired && !state.cleared && state.beat.t_start_s <= clock_s
          && actionRecords.some((record) => record.t_s >= state.beat.t_start_s && actionsEqual(record.action, state.beat.required_action))) {
          state.actionMatched = true;
        }
      }
    },
    getState(): ScenarioUiState {
      return makeState();
    },
    getTelemetry(): TelemetryFrame | null {
      return cloneTelemetry(latestFrame);
    },
  };
}

export type ScenarioDirector = ReturnType<typeof createScenarioDirector>;

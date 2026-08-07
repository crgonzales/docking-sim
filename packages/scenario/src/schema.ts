/**
 * Guided scenario schema v1. Angles are degrees at this schema boundary;
 * scenarioToSimConfig converts them to sim-core SI units.
 */

/** Section 6 defines the concrete panel IDs; the spec omits this alias in §3. */
export type PanelControlId = string;

export interface Scenario {
  schema_version: 1;
  id: string;
  title: string;
  briefing: string;                 // pre-start card
  seed: number;                     // master RNG seed
  clock: {
    duration_s: number;             // countdown length
    label: string;                  // e.g. "CONJUNCTION T-"
    expiry_outcome: OutcomeId;      // outcome forced at T-0 (via monitors)
  };
  initial: InitialConditions;
  monitors: Monitors;               // physics-side end conditions
  beats: Beat[];
  outcomes: Record<OutcomeId, Outcome>;
  scoring: Scoring;
  assist_default: 'GUIDED' | 'NO_ASSIST';
}

export interface InitialConditions {
  rel_position_m: [number, number, number];   // Hill frame
  rel_velocity_mps: [number, number, number];
  attitude_error_deg: [number, number, number];
  body_rates_dps: [number, number, number];
  controller: 'PID' | 'LQR' | 'MPC';
  control_mode: 'AUTO' | 'MANUAL';
  nav_source: 'PRIMARY' | 'BACKUP';
  prop_kg: number;
}

export interface Monitors {
  corridor_half_angle_deg: number;
  corridor_abort: boolean;              // violation ⇒ passive abort coast
  capture_envelope: {
    closing_mps: [number, number];      // [min, max]
    lateral_m: number;
    misalign_deg: number;
    rate_dps: number;
  };
  contact_outside_envelope: OutcomeId;  // typically 'COLLISION'
}

export interface Beat {
  id: string;
  t_start_s: number;                // trigger fires at this sim time
  trigger: FailureInjection;        // 'NONE' allowed (state-conditioned)
  guarantee?: FailureInjection;     // scripted floor: fired at t_start only if
                                    // clears_when is already satisfiable/met,
                                    // so the beat still teaches its feature
  required_action: PlayerAction;
  response_window_s: number;
  escalation?: { secondary: FailureInjection; note: string };
  clears_when: ClearCondition;
  prompts: {
    callout: string;                // one-line C&W text, uppercase
    hint_control: PanelControlId;   // control that glows in GUIDED mode
    alarm: 'MASTER' | 'CAUTION' | null;
  };
  debrief_if_causal: string;        // shown when this beat led to the end state
}

export type FailureInjection =
  | { kind: 'NONE' }
  | { kind: 'NAV_DEGRADE'; sensor: 'STAR_TRACKER' | 'RANGE';
      mode: 'BIAS_RAMP' | 'DROPOUT' | 'NOISE_X10';
      params?: Record<string, number> }
  | { kind: 'THRUSTER_STUCK'; thruster_id: string; stuck: 'OPEN' | 'CLOSED' }
  | { kind: 'GUIDANCE_FAULT'; mode: 'FREEZE_CMDS' }
  | { kind: 'VEL_BIAS'; dv_mps: [number, number, number] };  // director nudge, public API

export type PlayerAction =
  | { kind: 'SET_NAV_SOURCE'; to: 'PRIMARY' | 'BACKUP' }
  | { kind: 'ISOLATE_THRUSTER'; thruster_id: string }
  | { kind: 'SET_CONTROLLER'; to: 'PID' | 'LQR' | 'MPC' }
  | { kind: 'SET_CONTROL_MODE'; to: 'AUTO' | 'MANUAL' };

export type ClearCondition =
  | { kind: 'ACTION' }
  | { kind: 'ACTION_AND_TELEMETRY'; check: TelemetryCheck }
  | { kind: 'TELEMETRY'; check: TelemetryCheck };

export interface TelemetryCheck {
  signal: 'NEES' | 'CORRIDOR_ERR_M' | 'BODY_RATE_DPS' | 'RANGE_M';
  below: number;
  hold_s: number;
}

export type OutcomeId = 'DOCKED' | 'PASSIVE_ABORT' | 'COLLISION' | 'WINDOW_MISSED';
export interface Outcome { id: OutcomeId; title: string; debrief: string; }

export interface Scoring {
  weights: { prop_kg: number; time_margin_s: number; corridor_violations: number };
  grade_bounds: { A: number; B: number; C: number };   // score ≥ bound ⇒ grade
}

const OUTCOME_IDS: readonly OutcomeId[] = ['DOCKED', 'PASSIVE_ABORT', 'COLLISION', 'WINDOW_MISSED'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} has unknown field ${key}`);
  }
}

function assertRequired(value: Record<string, unknown>, required: readonly string[], name: string): void {
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`${name} is missing field ${key}`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
}

function assertFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}

function assertBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
}

function assertEnum<T extends string>(value: unknown, values: readonly T[], name: string): asserts value is T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError(`${name} has an invalid value`);
}

function assertTuple3(value: unknown, name: string): asserts value is [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} must be a three-element tuple`);
  value.forEach((entry, index) => assertFiniteNumber(entry, `${name}[${index}]`));
}

function assertTuple2(value: unknown, name: string): asserts value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${name} must be a two-element tuple`);
  value.forEach((entry, index) => assertFiniteNumber(entry, `${name}[${index}]`));
}

function validateParams(value: unknown, name: string): void {
  const params = assertRecord(value, name);
  for (const [key, entry] of Object.entries(params)) assertFiniteNumber(entry, `${name}.${key}`);
}

function validateFailureInjection(value: unknown, name: string): void {
  const injection = assertRecord(value, name);
  assertRequired(injection, ['kind'], name);
  assertString(injection.kind, `${name}.kind`);
  switch (injection.kind) {
    case 'NONE':
      assertKeys(injection, ['kind'], name);
      return;
    case 'NAV_DEGRADE':
      assertKeys(injection, ['kind', 'sensor', 'mode', 'params'], name);
      assertRequired(injection, ['sensor', 'mode'], name);
      assertEnum(injection.sensor, ['STAR_TRACKER', 'RANGE'], `${name}.sensor`);
      assertEnum(injection.mode, ['BIAS_RAMP', 'DROPOUT', 'NOISE_X10'], `${name}.mode`);
      if (injection.params !== undefined) validateParams(injection.params, `${name}.params`);
      return;
    case 'THRUSTER_STUCK':
      assertKeys(injection, ['kind', 'thruster_id', 'stuck'], name);
      assertRequired(injection, ['thruster_id', 'stuck'], name);
      assertString(injection.thruster_id, `${name}.thruster_id`);
      assertEnum(injection.stuck, ['OPEN', 'CLOSED'], `${name}.stuck`);
      return;
    case 'GUIDANCE_FAULT':
      assertKeys(injection, ['kind', 'mode'], name);
      assertRequired(injection, ['mode'], name);
      assertEnum(injection.mode, ['FREEZE_CMDS'], `${name}.mode`);
      return;
    case 'VEL_BIAS':
      assertKeys(injection, ['kind', 'dv_mps'], name);
      assertRequired(injection, ['dv_mps'], name);
      assertTuple3(injection.dv_mps, `${name}.dv_mps`);
      return;
    default:
      throw new TypeError(`${name}.kind has an invalid value`);
  }
}

function validatePlayerAction(value: unknown, name: string): void {
  const action = assertRecord(value, name);
  assertRequired(action, ['kind'], name);
  assertString(action.kind, `${name}.kind`);
  switch (action.kind) {
    case 'SET_NAV_SOURCE':
      assertKeys(action, ['kind', 'to'], name);
      assertRequired(action, ['to'], name);
      assertEnum(action.to, ['PRIMARY', 'BACKUP'], `${name}.to`);
      return;
    case 'ISOLATE_THRUSTER':
      assertKeys(action, ['kind', 'thruster_id'], name);
      assertRequired(action, ['thruster_id'], name);
      assertString(action.thruster_id, `${name}.thruster_id`);
      return;
    case 'SET_CONTROLLER':
      assertKeys(action, ['kind', 'to'], name);
      assertRequired(action, ['to'], name);
      assertEnum(action.to, ['PID', 'LQR', 'MPC'], `${name}.to`);
      return;
    case 'SET_CONTROL_MODE':
      assertKeys(action, ['kind', 'to'], name);
      assertRequired(action, ['to'], name);
      assertEnum(action.to, ['AUTO', 'MANUAL'], `${name}.to`);
      return;
    default:
      throw new TypeError(`${name}.kind has an invalid value`);
  }
}

function validateTelemetryCheck(value: unknown, name: string): void {
  const check = assertRecord(value, name);
  assertKeys(check, ['signal', 'below', 'hold_s'], name);
  assertRequired(check, ['signal', 'below', 'hold_s'], name);
  assertEnum(check.signal, ['NEES', 'CORRIDOR_ERR_M', 'BODY_RATE_DPS', 'RANGE_M'], `${name}.signal`);
  assertFiniteNumber(check.below, `${name}.below`);
  assertFiniteNumber(check.hold_s, `${name}.hold_s`);
}

function validateClearCondition(value: unknown, name: string): void {
  const condition = assertRecord(value, name);
  assertRequired(condition, ['kind'], name);
  assertString(condition.kind, `${name}.kind`);
  switch (condition.kind) {
    case 'ACTION':
      assertKeys(condition, ['kind'], name);
      return;
    case 'ACTION_AND_TELEMETRY':
    case 'TELEMETRY':
      assertKeys(condition, ['kind', 'check'], name);
      assertRequired(condition, ['check'], name);
      validateTelemetryCheck(condition.check, `${name}.check`);
      return;
    default:
      throw new TypeError(`${name}.kind has an invalid value`);
  }
}

function validateBeat(value: unknown, index: number): void {
  const name = `beats[${index}]`;
  const beat = assertRecord(value, name);
  assertKeys(beat, ['id', 't_start_s', 'trigger', 'guarantee', 'required_action', 'response_window_s', 'escalation', 'clears_when', 'prompts', 'debrief_if_causal'], name);
  assertRequired(beat, ['id', 't_start_s', 'trigger', 'required_action', 'response_window_s', 'clears_when', 'prompts', 'debrief_if_causal'], name);
  assertString(beat.id, `${name}.id`);
  assertFiniteNumber(beat.t_start_s, `${name}.t_start_s`);
  validateFailureInjection(beat.trigger, `${name}.trigger`);
  if (beat.guarantee !== undefined) validateFailureInjection(beat.guarantee, `${name}.guarantee`);
  validatePlayerAction(beat.required_action, `${name}.required_action`);
  assertFiniteNumber(beat.response_window_s, `${name}.response_window_s`);
  if (beat.escalation !== undefined) {
    const escalation = assertRecord(beat.escalation, `${name}.escalation`);
    assertKeys(escalation, ['secondary', 'note'], `${name}.escalation`);
    assertRequired(escalation, ['secondary', 'note'], `${name}.escalation`);
    validateFailureInjection(escalation.secondary, `${name}.escalation.secondary`);
    assertString(escalation.note, `${name}.escalation.note`);
  }
  validateClearCondition(beat.clears_when, `${name}.clears_when`);
  const prompts = assertRecord(beat.prompts, `${name}.prompts`);
  assertKeys(prompts, ['callout', 'hint_control', 'alarm'], `${name}.prompts`);
  assertRequired(prompts, ['callout', 'hint_control', 'alarm'], `${name}.prompts`);
  assertString(prompts.callout, `${name}.prompts.callout`);
  assertString(prompts.hint_control, `${name}.prompts.hint_control`);
  if (prompts.alarm !== null) assertEnum(prompts.alarm, ['MASTER', 'CAUTION'], `${name}.prompts.alarm`);
  assertString(beat.debrief_if_causal, `${name}.debrief_if_causal`);
}

function validateOutcome(value: unknown, name: string): Outcome {
  const outcome = assertRecord(value, name);
  assertKeys(outcome, ['id', 'title', 'debrief'], name);
  assertRequired(outcome, ['id', 'title', 'debrief'], name);
  assertEnum(outcome.id, OUTCOME_IDS, `${name}.id`);
  assertString(outcome.title, `${name}.title`);
  assertString(outcome.debrief, `${name}.debrief`);
  return outcome as unknown as Outcome;
}

export function validateScenario(x: unknown): Scenario {
  const scenario = assertRecord(x, 'scenario');
  assertKeys(scenario, ['schema_version', 'id', 'title', 'briefing', 'seed', 'clock', 'initial', 'monitors', 'beats', 'outcomes', 'scoring', 'assist_default'], 'scenario');
  assertRequired(scenario, ['schema_version', 'id', 'title', 'briefing', 'seed', 'clock', 'initial', 'monitors', 'beats', 'outcomes', 'scoring', 'assist_default'], 'scenario');
  if (scenario.schema_version !== 1) throw new TypeError('scenario.schema_version must be 1');
  assertString(scenario.id, 'scenario.id');
  assertString(scenario.title, 'scenario.title');
  assertString(scenario.briefing, 'scenario.briefing');
  assertFiniteNumber(scenario.seed, 'scenario.seed');

  const clock = assertRecord(scenario.clock, 'scenario.clock');
  assertKeys(clock, ['duration_s', 'label', 'expiry_outcome'], 'scenario.clock');
  assertRequired(clock, ['duration_s', 'label', 'expiry_outcome'], 'scenario.clock');
  assertFiniteNumber(clock.duration_s, 'scenario.clock.duration_s');
  assertString(clock.label, 'scenario.clock.label');
  assertEnum(clock.expiry_outcome, OUTCOME_IDS, 'scenario.clock.expiry_outcome');

  const initial = assertRecord(scenario.initial, 'scenario.initial');
  assertKeys(initial, ['rel_position_m', 'rel_velocity_mps', 'attitude_error_deg', 'body_rates_dps', 'controller', 'control_mode', 'nav_source', 'prop_kg'], 'scenario.initial');
  assertRequired(initial, ['rel_position_m', 'rel_velocity_mps', 'attitude_error_deg', 'body_rates_dps', 'controller', 'control_mode', 'nav_source', 'prop_kg'], 'scenario.initial');
  assertTuple3(initial.rel_position_m, 'scenario.initial.rel_position_m');
  assertTuple3(initial.rel_velocity_mps, 'scenario.initial.rel_velocity_mps');
  assertTuple3(initial.attitude_error_deg, 'scenario.initial.attitude_error_deg');
  assertTuple3(initial.body_rates_dps, 'scenario.initial.body_rates_dps');
  assertEnum(initial.controller, ['PID', 'LQR', 'MPC'], 'scenario.initial.controller');
  assertEnum(initial.control_mode, ['AUTO', 'MANUAL'], 'scenario.initial.control_mode');
  assertEnum(initial.nav_source, ['PRIMARY', 'BACKUP'], 'scenario.initial.nav_source');
  assertFiniteNumber(initial.prop_kg, 'scenario.initial.prop_kg');

  const monitors = assertRecord(scenario.monitors, 'scenario.monitors');
  assertKeys(monitors, ['corridor_half_angle_deg', 'corridor_abort', 'capture_envelope', 'contact_outside_envelope'], 'scenario.monitors');
  assertRequired(monitors, ['corridor_half_angle_deg', 'corridor_abort', 'capture_envelope', 'contact_outside_envelope'], 'scenario.monitors');
  assertFiniteNumber(monitors.corridor_half_angle_deg, 'scenario.monitors.corridor_half_angle_deg');
  assertBoolean(monitors.corridor_abort, 'scenario.monitors.corridor_abort');
  assertEnum(monitors.contact_outside_envelope, OUTCOME_IDS, 'scenario.monitors.contact_outside_envelope');
  const capture = assertRecord(monitors.capture_envelope, 'scenario.monitors.capture_envelope');
  assertKeys(capture, ['closing_mps', 'lateral_m', 'misalign_deg', 'rate_dps'], 'scenario.monitors.capture_envelope');
  assertRequired(capture, ['closing_mps', 'lateral_m', 'misalign_deg', 'rate_dps'], 'scenario.monitors.capture_envelope');
  assertTuple2(capture.closing_mps, 'scenario.monitors.capture_envelope.closing_mps');
  assertFiniteNumber(capture.lateral_m, 'scenario.monitors.capture_envelope.lateral_m');
  assertFiniteNumber(capture.misalign_deg, 'scenario.monitors.capture_envelope.misalign_deg');
  assertFiniteNumber(capture.rate_dps, 'scenario.monitors.capture_envelope.rate_dps');

  if (!Array.isArray(scenario.beats)) throw new TypeError('scenario.beats must be an array');
  scenario.beats.forEach((beat, index) => validateBeat(beat, index));

  const outcomes = assertRecord(scenario.outcomes, 'scenario.outcomes');
  const outcomeKeys = Object.keys(outcomes);
  if (outcomeKeys.length !== OUTCOME_IDS.length || OUTCOME_IDS.some((id) => !outcomeKeys.includes(id))) {
    throw new TypeError('scenario.outcomes must contain exactly the schema outcome IDs');
  }
  for (const id of OUTCOME_IDS) {
    const outcome = validateOutcome(outcomes[id], `scenario.outcomes.${id}`);
    if (outcome.id !== id) throw new TypeError(`scenario.outcomes.${id}.id must match its key`);
  }

  const scoring = assertRecord(scenario.scoring, 'scenario.scoring');
  assertKeys(scoring, ['weights', 'grade_bounds'], 'scenario.scoring');
  assertRequired(scoring, ['weights', 'grade_bounds'], 'scenario.scoring');
  const weights = assertRecord(scoring.weights, 'scenario.scoring.weights');
  assertKeys(weights, ['prop_kg', 'time_margin_s', 'corridor_violations'], 'scenario.scoring.weights');
  assertRequired(weights, ['prop_kg', 'time_margin_s', 'corridor_violations'], 'scenario.scoring.weights');
  assertFiniteNumber(weights.prop_kg, 'scenario.scoring.weights.prop_kg');
  assertFiniteNumber(weights.time_margin_s, 'scenario.scoring.weights.time_margin_s');
  assertFiniteNumber(weights.corridor_violations, 'scenario.scoring.weights.corridor_violations');
  const gradeBounds = assertRecord(scoring.grade_bounds, 'scenario.scoring.grade_bounds');
  assertKeys(gradeBounds, ['A', 'B', 'C'], 'scenario.scoring.grade_bounds');
  assertRequired(gradeBounds, ['A', 'B', 'C'], 'scenario.scoring.grade_bounds');
  assertFiniteNumber(gradeBounds.A, 'scenario.scoring.grade_bounds.A');
  assertFiniteNumber(gradeBounds.B, 'scenario.scoring.grade_bounds.B');
  assertFiniteNumber(gradeBounds.C, 'scenario.scoring.grade_bounds.C');
  assertEnum(scenario.assist_default, ['GUIDED', 'NO_ASSIST'], 'scenario.assist_default');

  return scenario as unknown as Scenario;
}

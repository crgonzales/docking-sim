# Guided Scenario Mode — Spec v1 ("Mission Mode")

Input document for `planning` (Phase 5). Defines the scenario schema, the
`FINAL_APPROACH_01` script, ScenarioDirector semantics, switch-panel bindings,
and acceptance tests.

**Concept:** a timed emergency that doubles as a forced feature tour. A countdown
runs toward disaster; scripted failures fire on a timeline; each one can only be
cleared by flipping a real control. Failures are scripted — recovery physics is
100% live.

**Depends on:** discrete thrusters + allocator + EKF (Phase 2), 6-DOF + MEKF +
docking camera + manual fly (Phase 3), MPC + corridor/abort monitors (Phase 4).

---

## 1. Hard rules (the honesty invariant)

1. The ScenarioDirector lives **outside** sim-core FSW (own package or app layer).
2. It may act on the sim **only** through the same public interfaces the sandbox
   UI uses: the failure-injection API and the operator command API. It never
   writes FSW or truth state directly. Enforced by test (§7.4).
3. All randomness derives from `scenario.seed`. Director events fire on **sim
   time**, never wall time. Two runs with the same seed and same inputs are
   bit-identical.
4. Pause pauses the scenario clock. Time-warp is disabled in scenario mode.
5. The assist/hint layer reads scenario state only; it never touches physics.

---

## 2. Frames, units, conventions

- LVLH/Hill frame, origin at target COM: **x̂** radial outward from Earth,
  **ŷ** along-track (+velocity), **ẑ = x̂ × ŷ** cross-track. Chaser approaches
  along −ŷ (V-bar approach ⇒ initial y < 0).
- SI units; angles in degrees at the schema boundary; time in sim-seconds.
- If ARCHI.md's Conventions section differs, **ARCHI.md wins** — update this doc.

---

## 3. Schema (TypeScript, `schema_version: 1`)

```ts
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
  trigger: FailureInjection;        // 'NONE' allowed (state-conditioned beat)
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
```

Notes:
- Master-alarm acknowledgement is panel behavior (silences audio), not a
  `PlayerAction`; it never gates a beat.
- `guarantee` exists so a state-conditioned beat (trigger `NONE`) still fires its
  teaching moment if the player flew too well — see Beat 3.

---

## 4. Scenario: `FINAL_APPROACH_01`

```ts
export const FINAL_APPROACH_01: Scenario = {
  schema_version: 1,
  id: 'FINAL_APPROACH_01',
  title: 'Final Approach',
  briefing:
    'Debris conjunction alert. You have 6 minutes to dock and safe-haven, ' +
    'or abort clear. Autopilot is flying the approach. Monitor systems and ' +
    'respond to cautions. Good luck.',
  seed: 20260805,
  clock: { duration_s: 360, label: 'CONJUNCTION T-', expiry_outcome: 'WINDOW_MISSED' },

  initial: {
    rel_position_m: [0, -250, 12],          // 250 m behind on V-bar, 12 m cross-track
    rel_velocity_mps: [0, 0.85, -0.05],
    attitude_error_deg: [1.5, -2.0, 0.8],
    body_rates_dps: [0.05, -0.02, 0.03],
    controller: 'LQR',
    control_mode: 'AUTO',
    nav_source: 'PRIMARY',
    prop_kg: 24.0,
  },

  monitors: {
    corridor_half_angle_deg: 10,
    corridor_abort: true,
    capture_envelope: {
      closing_mps: [0.03, 0.10],
      lateral_m: 0.10,
      misalign_deg: 4.0,
      rate_dps: 0.15,
    },
    contact_outside_envelope: 'COLLISION',
  },

  beats: [
    {
      id: 'B1_NAV_GLITCH',
      t_start_s: 30,
      trigger: { kind: 'NAV_DEGRADE', sensor: 'STAR_TRACKER', mode: 'BIAS_RAMP',
                 params: { deg_per_min: 0.8 } },
      required_action: { kind: 'SET_NAV_SOURCE', to: 'BACKUP' },
      response_window_s: 45,
      escalation: {
        secondary: { kind: 'NAV_DEGRADE', sensor: 'RANGE', mode: 'NOISE_X10' },
        note: 'Nav residuals ignored; range solution degraded.',
      },
      clears_when: { kind: 'ACTION_AND_TELEMETRY',
                     check: { signal: 'NEES', below: 3.0, hold_s: 5 } },
      prompts: { callout: 'STR TRK FAULT — NAV RESIDUALS RISING',
                 hint_control: 'NAV_SRC', alarm: 'CAUTION' },
      debrief_if_causal:
        'Star tracker bias corrupted the attitude solution. Switching NAV to ' +
        'backup rejects the failed sensor; watch the covariance collapse.',
    },
    {
      id: 'B2_RCS_STUCK',
      t_start_s: 90,
      trigger: { kind: 'THRUSTER_STUCK', thruster_id: 'J6', stuck: 'OPEN' },
      required_action: { kind: 'ISOLATE_THRUSTER', thruster_id: 'J6' },
      response_window_s: 40,
      clears_when: { kind: 'ACTION_AND_TELEMETRY',
                     check: { signal: 'BODY_RATE_DPS', below: 1.5, hold_s: 5 } },
      prompts: { callout: 'RCS J6 STUCK OPEN — ISOLATE',
                 hint_control: 'RCS_ISO_J6', alarm: 'MASTER' },
      debrief_if_causal:
        'A stuck-open jet torques and translates the vehicle continuously ' +
        '(Gemini 8, 1966). Isolating it lets the allocator reconfigure around ' +
        'the dead thruster.',
    },
    {
      id: 'B3_CTRL_RECAPTURE',
      t_start_s: 180,
      trigger: { kind: 'NONE' },                       // state-conditioned
      guarantee: { kind: 'VEL_BIAS', dv_mps: [0.04, 0, 0.06] },
      required_action: { kind: 'SET_CONTROLLER', to: 'MPC' },
      response_window_s: 45,
      clears_when: { kind: 'ACTION_AND_TELEMETRY',
                     check: { signal: 'CORRIDOR_ERR_M', below: 1.0, hold_s: 8 } },
      prompts: { callout: 'CORRIDOR EXCURSION — SELECT CONSTRAINED CTRL',
                 hint_control: 'CTRL_MODE', alarm: 'CAUTION' },
      debrief_if_causal:
        'With an asymmetric thruster set, the unconstrained controller cannot ' +
        'recapture inside the cone. MPC enforces the corridor and velocity ' +
        'limits explicitly.',
    },
    {
      id: 'B4_MANUAL_TAKEOVER',
      t_start_s: 270,
      trigger: { kind: 'GUIDANCE_FAULT', mode: 'FREEZE_CMDS' },
      required_action: { kind: 'SET_CONTROL_MODE', to: 'MANUAL' },
      response_window_s: 30,
      clears_when: { kind: 'ACTION' },                 // then fly to capture
      prompts: { callout: 'GUIDANCE FAULT — TAKE MANUAL',
                 hint_control: 'AUTO_MANUAL', alarm: 'MASTER' },
      debrief_if_causal:
        'Guidance froze on final. Lift the guard, take the stick, and fly the ' +
        'docking camera to capture-envelope numbers.',
    },
  ],

  outcomes: {
    DOCKED: { id: 'DOCKED', title: 'CAPTURE CONFIRMED',
      debrief: 'Soft capture inside the envelope. Grade breakdown follows.' },
    PASSIVE_ABORT: { id: 'PASSIVE_ABORT', title: 'ABORT — SAFE COAST',
      debrief: 'Corridor violated; the abort put you on a passively safe coast. ' +
               'Safe, but the window is gone.' },
    COLLISION: { id: 'COLLISION', title: 'CONTACT OUTSIDE ENVELOPE',
      debrief: 'Contact outside the capture envelope. Review closing rate and ' +
               'alignment at contact.' },
    WINDOW_MISSED: { id: 'WINDOW_MISSED', title: 'CONJUNCTION — RETREAT',
      debrief: 'T-0 with no capture. Auto-retreat executed.' },
  },

  scoring: {
    weights: { prop_kg: -3.0, time_margin_s: 0.2, corridor_violations: -15 },
    grade_bounds: { A: 85, B: 70, C: 50 },
  },
  assist_default: 'GUIDED',
};
```

---

## 5. ScenarioDirector semantics

Per sim tick, in order:

1. Advance scenario clock (sim time). At T-0: command retreat via public API;
   monitors resolve `WINDOW_MISSED` unless capture already latched.
2. Fire any beat whose `t_start_s` was reached: apply `trigger` via the
   failure-injection API. For a `NONE` trigger, apply `guarantee` only if
   `clears_when` is already satisfied at that instant (player flew too well).
3. Evaluate active beats' `clears_when` against the telemetry bus; latch clears.
4. On `response_window_s` expiry without clear: apply `escalation.secondary`
   (if any) once; mark beat causal-candidate.
5. Evaluate monitors (corridor, capture envelope, contact) → resolve outcome if
   tripped. First outcome latches; director stops injecting.
6. Emit UI state: active callouts, hint target (GUIDED only), alarm level,
   clock, score inputs.

Retry = full sim reset with the same `seed`. Debrief card shows the outcome
plus `debrief_if_causal` of the latest uncleared/escalated beat, if any.

---

## 6. Switch panel bindings

| Control id   | Widget                          | Emits                                   |
|--------------|---------------------------------|------------------------------------------|
| `NAV_SRC`    | 2-pos toggle PRIMARY/BACKUP     | `SET_NAV_SOURCE`                         |
| `RCS_ISO_J6` | guarded valve toggle (per jet: `RCS_ISO_<id>`) | `ISOLATE_THRUSTER`        |
| `CTRL_MODE`  | 3-pos selector PID/LQR/MPC      | `SET_CONTROLLER`                         |
| `AUTO_MANUAL`| guarded cover + toggle          | `SET_CONTROL_MODE`                       |
| `MASTER_ALARM`| lit pushbutton                 | silences audio only; never gates a beat  |
| `ABORT`      | guarded cover + pushbutton      | manual abort via public API (always available) |

Panel behaviors: guarded switches need two interactions (lift, flip); every flip
has a click sound; C&W lights mirror `prompts.alarm`; in GUIDED mode the
`hint_control` glows with the callout beside it; NO_ASSIST shows callouts only.

---

## 7. Acceptance tests (testing gate)

1. **Determinism:** two runs, same seed, scripted identical inputs ⇒ identical
   trajectory hash and identical outcome.
2. **Interactivity is load-bearing:** zero-input run ends in
   `PASSIVE_ABORT` or `WINDOW_MISSED` — never `DOCKED`, never `COLLISION`
   (abort monitor must catch the stuck-jet drift).
3. **Completable:** a scripted "perfect operator" bot (acts at each beat +
   canned manual-fly inputs) ends in `DOCKED`. Runs in CI as regression.
4. **Honesty invariant:** static/lint check — the director package imports only
   the public injection + command APIs; any sim-core internal import fails CI.
5. **Schema:** `FINAL_APPROACH_01` validates against schema v1; unknown fields
   rejected.

---

## 8. Paste-ready `planning` prompt

> Plan the Guided Scenario feature per `docs/scenario-mode-spec.md` (schema v1).
> Scope: `ScenarioDirector` (own package, public sim APIs only), scenario schema
> + validation, `FINAL_APPROACH_01` data, switch-panel control bindings and C&W
> behavior per §6, debrief/retry flow, GUIDED/NO_ASSIST modes, and the five
> acceptance tests in §7 wired into the testing gate. Out of scope: new physics,
> new failure types beyond the injection API, scoring UI polish. Constraints:
> deterministic under `seed`, sim-time driven, time-warp disabled in scenario
> mode, master alarm never gates a beat.

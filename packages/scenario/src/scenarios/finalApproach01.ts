import type { Scenario } from '../schema.js';

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
    corridor_abort: true,              // violation ⇒ passive abort coast
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
      // 'J6' is a real jet id (J1-J16); the beat name 'B2' is not one.
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

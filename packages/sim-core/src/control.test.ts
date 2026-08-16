import { describe, expect, it } from 'vitest';
import { hillToBody, smallAngleExp } from './attitude.js';
import { stepTruth } from './dynamics.js';
import { createGuidance } from './guidance.js';
import {
  createAttitudeController,
  createLqrController,
  createPidController,
  MANUAL_AUTHORITY_PRESETS,
} from './control.js';
import type { State6 } from './ekf.js';
import type { TruthState, Vec3 } from './types.js';

const initialState: State6 = [10, -100, 3, 0, 0, 0];
const guidance = createGuidance({ initialState, closingGain_s_inv: 0.02, maxClosingSpeed_mps: 0.5 });

function simulate(controller: { step(state: State6, reference: ReturnType<typeof guidance.reference>): Vec3 }): State6 {
  let truth: TruthState = {
    t_s: 0,
    r_hill_m: [initialState[0], initialState[1], initialState[2]],
    v_hill_mps: [initialState[3], initialState[4], initialState[5]],
    q_BI: [1, 0, 0, 0],
    w_body_rps: [0, 0, 0],
    prop_kg: 24,
  };
  const mass_kg = 1_000;
  for (let step = 0; step < 3_000; step += 1) {
    const reference = guidance.reference(truth.t_s);
    const state: State6 = [...truth.r_hill_m, ...truth.v_hill_mps] as State6;
    const force_N = controller.step(state, reference);
    truth = stepTruth(truth, {
      externalSpecificForce_hill_mps2: force_N.map((value) => value / mass_kg) as Vec3,
      dt_s: 0.1,
    });
  }
  return [...truth.r_hill_m, ...truth.v_hill_mps] as State6;
}

describe('guidance controllers', () => {
  it('has a small DARE fixed-point residual and a stable LQR closed loop', () => {
    const lqr = createLqrController({
      dt_s: 0.1,
      mass_kg: 1_000,
      qWeights: [1, 1, 1, 10, 10, 10],
      rWeights: [1, 1, 1],
    });
    expect(lqr.riccatiResidual).toBeLessThan(1e-6);
    let vector = [1, 0.7, -0.4, 0.1, -0.2, 0.3];
    let growth = Number.POSITIVE_INFINITY;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const next = lqr.closedLoopMatrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index]!, 0));
      const nextNorm = Math.hypot(...next);
      const currentNorm = Math.hypot(...vector);
      growth = nextNorm / currentNorm;
      vector = next;
    }
    expect(growth).toBeLessThan(1);
  });

  it('drives a noise-free CW plant toward the guidance reference with PID and LQR', () => {
    const pid = createPidController({
      gains: { kp_N_per_m: 20, ki_N_per_m_s: 0.2, kd_N_s_per_m: 100 },
      maxForce_N: 100,
    });
    const lqr = createLqrController({ dt_s: 0.1, mass_kg: 1_000, maxForce_N: 100 });
    const pidState = simulate(pid);
    const lqrState = simulate(lqr);
    const target = guidance.reference(300).state;
    const positionError = (state: State6) => Math.hypot(state[0] - target[0], state[1] - target[1], state[2] - target[2]);
    expect(positionError(pidState)).toBeLessThan(20);
    expect(positionError(lqrState)).toBeLessThan(20);
  });

  it('drives a tumbling rigid body to and holds LVLH attitude', () => {
    let truth: TruthState = {
      t_s: 0,
      r_hill_m: [0, -100, 0],
      v_hill_mps: [0, 0, 0],
      q_BI: smallAngleExp([0.25, -0.18, 0.2]),
      w_body_rps: [0.04, -0.03, 0.025],
      prop_kg: 24,
    };
    const controller = createAttitudeController({ maxTorque_Nm: 8 });
    for (let step = 0; step < 2_000; step += 1) {
      const torque_body_Nm = controller.stepAuto(truth.q_BI, truth.t_s, truth.w_body_rps);
      truth = stepTruth(truth, { dt_s: 0.01, torque_body_Nm });
    }
    const q_BH = hillToBody(truth.q_BI, truth.t_s);
    const attitudeError = Math.hypot(q_BH[1], q_BH[2], q_BH[3]);
    expect(attitudeError).toBeLessThan(0.03);
    expect(Math.hypot(...truth.w_body_rps)).toBeLessThan(0.01);
    for (let step = 0; step < 500; step += 1) {
      const torque_body_Nm = controller.stepAuto(truth.q_BI, truth.t_s, truth.w_body_rps);
      truth = stepTruth(truth, { dt_s: 0.01, torque_body_Nm });
    }
    const heldQ_BH = hillToBody(truth.q_BI, truth.t_s);
    expect(Math.hypot(heldQ_BH[1], heldQ_BH[2], heldQ_BH[3])).toBeLessThan(0.03);
    expect(Math.hypot(...truth.w_body_rps)).toBeLessThan(0.01);
  }, 30_000);

  it('captures, integrates, and latches manual RATE references without transition snaps', () => {
    const controller = createAttitudeController({ maxTorque_Nm: 8 });
    const q_BH = smallAngleExp([0.1, -0.05, 0.02]);
    controller.captureReference(q_BH, [4, -8, 2]);
    const first = controller.stepRate(q_BH, [0, 0, 0], [4, -8, 2], {
      translation: [0.5, 0, 0],
      rotation: [1, 0, 0],
    }, 0.1);
    const second = controller.stepRate(q_BH, [0, 0, 0], [4, -8, 2], {
      translation: [0, 0, 0],
      rotation: [0, 0, 0],
    }, 0.1);
    expect(first.reference.q_target_BH).not.toEqual(q_BH);
    expect(second.reference.q_target_BH).toEqual(first.reference.q_target_BH);
    expect(second.reference.velocity_ref_body_mps).toEqual([0, 0, 0]);

    controller.captureReference([1, 0, 0, 0], [0, 0, 0]);
    const recaptured = controller.stepRate([1, 0, 0, 0], [0, 0, 0], [0, 0, 0], {
      translation: [0, 0, 0],
      rotation: [0, 0, 0],
    }, 0.01);
    expect(Math.hypot(...recaptured.torque_body_Nm)).toBeLessThan(8);
  });

  it('switches authority without a rate-reference jump', () => {
    const q_BH: [number, number, number, number] = [1, 0, 0, 0];
    const r_hill_m: Vec3 = [4, -8, 2];
    const omega_body_rps: Vec3 = [0.01, -0.02, 0.015];
    const controller = createAttitudeController({ initialManualAuthority: 'LOW' });
    controller.captureReference(q_BH, r_hill_m);
    controller.stepRate(q_BH, omega_body_rps, r_hill_m, {
      translation: [0, 0, 0],
      rotation: [1, 0, 0],
    }, 0.1);

    controller.setAuthority('HIGH');
    expect(controller.getAuthority()).toBe('HIGH');
    const recaptured = controller.getReference();
    expect(recaptured).toEqual({
      q_target_BH: q_BH,
      omega_ref_body_rps: recaptured!.omega_ref_body_rps,
      r_target_hill_m: r_hill_m,
      velocity_ref_body_mps: [0, 0, 0],
      velocity_ref_hill_mps: [0, 0, 0],
    });
    const switched = controller.stepRate(q_BH, omega_body_rps, r_hill_m, {
      translation: [0, 0, 0],
      rotation: [0, 0, 0],
    }, 0.1);
    expect(switched.reference.q_target_BH).toEqual(q_BH);
    expect(switched.reference.r_target_hill_m).toEqual(r_hill_m);

    const switchedTruth = stepTruth({
      t_s: 0,
      r_hill_m,
      v_hill_mps: [0, 0, 0],
      q_BI: q_BH,
      w_body_rps: omega_body_rps,
      prop_kg: 24,
    }, { dt_s: 0.01, torque_body_Nm: switched.torque_body_Nm });
    expect(Math.hypot(
      switchedTruth.w_body_rps[0] - omega_body_rps[0],
      switchedTruth.w_body_rps[1] - omega_body_rps[1],
      switchedTruth.w_body_rps[2] - omega_body_rps[2],
    )).toBeLessThan(0.01);
  });

  it('compensates the LVLH base rate when holding still in Hill', () => {
    const controller = createAttitudeController();
    const meanMotionRadS = 0.001;
    const hold = createAttitudeController({ meanMotionRadS });
    const torque = hold.stepAuto([1, 0, 0, 0], 0, [0, 0, meanMotionRadS]);
    expect(Math.hypot(...torque)).toBeLessThan(1e-9);
    const low = controller.getResolvedManualLimits();
    const lowPreset = MANUAL_AUTHORITY_PRESETS.LOW;
    const expand = (value: number | Vec3): Vec3 => typeof value === 'number' ? [value, value, value] : [...value];
    expect(low.maxRate_rps).toEqual(expand(lowPreset.maxRate_rps));
    expect(low.maxVelocity_mps).toEqual(expand(lowPreset.maxVelocity_mps));
    expect(low.pulseForce_N).toEqual(expand(lowPreset.pulseForce_N));
    expect(low.pulseTorque_Nm).toEqual(expand(lowPreset.pulseTorque_Nm));
    expect(controller.shapeRate({ translation: [1, -1, 0.5], rotation: [1, 0, -1] })).toEqual({
      bodyRate_rps: [low.maxRate_rps[0], 0, -low.maxRate_rps[2]],
      velocity_body_mps: [low.maxVelocity_mps[0], -low.maxVelocity_mps[1], low.maxVelocity_mps[2] / 2],
    });
    expect(controller.shapePulse({ translation: [1, 0, -1], rotation: [0, 0.5, 0] })).toEqual({
      force_body_N: [low.pulseForce_N[0], 0, -low.pulseForce_N[2]],
      torque_body_Nm: [0, low.pulseTorque_Nm[1] / 2, 0],
    });
  });
});

import { MEAN_MOTION_RAD_S, conjugateQuaternion, rotateVector, type ManualCommand, type TelemetryFrame, type Vec3 } from '@docking/sim-core';
import type { Scenario, PlayerAction } from './schema.js';
import type { ScenarioDirector, ScenarioSimPort, ScenarioUiState } from './director.js';

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function manualCommand(
  telemetry: TelemetryFrame | null,
  elapsed_s: number,
  manualDuration_s: number,
  startY_m: number | null,
  startVelocityY_mps: number,
  velocity: Vec3,
): ManualCommand {
  if (telemetry === null) return { translation: [0, 1, 0], rotation: [0, 0, 0] };
  const position = telemetry.nav_r_hill_m;
  // Aim the actual docking point at the station, rather than baking a
  // lateral offset into the trajectory to cancel one allocator's attitude lag.
  const portOffset = rotateVector(conjugateQuaternion(telemetry.q_BH_est), [0, 1.7, 0]);
  const target: Vec3 = [-portOffset[0], -8.7 - portOffset[1], -portOffset[2]];
  const lateralScale = telemetry.range_m < 50 ? 0.5 : 4;
  // Fit the takeover position AND velocity to a gentle final crawl. A fixed
  // peak-speed script assumed the old craft's response and arrived too hot.
  const terminalVelocity = 0.07;
  const duration = Math.max(1, manualDuration_s - 6);
  const start = startY_m ?? position[1];
  const distance = target[1] - 0.6 - start;
  const a2 = 3 * distance / duration ** 2 - (2 * startVelocityY_mps + terminalVelocity) / duration;
  const a3 = -2 * distance / duration ** 3 + (startVelocityY_mps + terminalVelocity) / duration ** 2;
  const t = Math.min(elapsed_s, duration);
  const desiredPosition = start + startVelocityY_mps * t + a2 * t ** 2 + a3 * t ** 3
    + terminalVelocity * Math.max(0, elapsed_s - duration);
  const desiredVelocity = startVelocityY_mps + 2 * a2 * t + 3 * a3 * t ** 2;
  const desiredAcceleration = elapsed_s < duration ? 2 * a2 + 6 * a3 * t : 0;
  const longitudinalAcceleration = desiredAcceleration + 0.3 * (desiredVelocity - velocity[1])
    + 0.015 * (desiredPosition - position[1]);
  const forward = clamp(longitudinalAcceleration / 0.04, -1, 1);
  const translation: Vec3 = [
    clamp((target[0] - position[0]) / lateralScale - velocity[0] / 0.1, -1, 1),
    forward,
    clamp((target[2] - position[2]) / lateralScale - velocity[2] / 0.1, -1, 1),
  ];
  const rates = telemetry.body_rate_dps_est;
  const attitude = telemetry.q_BH_est;
  // Docking holds attitude relative to the rotating Hill frame. Damping the
  // inertial gyro rate to zero fights that hold and leaves a steady pointing
  // error large enough to miss capture with the registered Dragon layout.
  const holdRates = rotateVector(attitude, [0, 0, MEAN_MOTION_RAD_S * 180 / Math.PI]);
  const bodyTranslation = rotateVector(attitude, translation);
  const commandScale = Math.max(1, ...bodyTranslation.map(Math.abs));
  return {
    translation: bodyTranslation.map(axis => axis / commandScale) as Vec3,
    rotation: [
      clamp(4 * attitude[1] - (rates[0] - holdRates[0]) / 0.5, -1, 1),
      clamp(4 * attitude[2] - (rates[1] - holdRates[1]) / 0.5, -1, 1),
      clamp(4 * attitude[3] - (rates[2] - holdRates[2]) / 0.5, -1, 1),
    ],
  };
}

export interface PerfectOperatorBot {
  step(state?: ScenarioUiState, telemetry?: TelemetryFrame | null): void;
  tick(state?: ScenarioUiState, telemetry?: TelemetryFrame | null): void;
}

/**
 * Deterministic scripted operator used by scenario acceptance and batch runs.
 * It only observes director state/telemetry and sends public operator commands.
 */
export function createPerfectOperatorBot(
  scenario: Scenario,
  director: ScenarioDirector,
  simPort: ScenarioSimPort,
): PerfectOperatorBot {
  const actionSent = new Set<string>();
  let manual = false;
  let manualStart_s: number | null = null;
  let manualDuration_s = 90;
  let manualStartY_m: number | null = null;
  let manualStartVelocityY_mps = 0;
  let previousPosition: Vec3 | null = null;
  let previousTime_s: number | null = null;
  let observedVelocity: Vec3 = [0, 0, 0];
  const beatsById = new Map(scenario.beats.map((beat) => [beat.id, beat]));

  const act = (state: ScenarioUiState, telemetry: TelemetryFrame | null): void => {
    if (state.phase !== 'RUNNING') return;
    if (telemetry !== null && (previousTime_s === null || telemetry.t_s > previousTime_s)) {
      if (previousPosition !== null && previousTime_s !== null) observedVelocity = [0, 1, 2].map(axis =>
        (telemetry.nav_r_hill_m[axis]! - previousPosition![axis]!) / (telemetry.t_s - previousTime_s!)) as Vec3;
      previousPosition = [...telemetry.nav_r_hill_m]; previousTime_s = telemetry.t_s;
    }
    const velocity = observedVelocity;
    for (const callout of state.active_callouts) {
      if (actionSent.has(callout.beat_id)) continue;
      const beat = beatsById.get(callout.beat_id);
      if (beat === undefined) continue;
      const action: PlayerAction = beat.required_action;
      director.dispatchPlayerAction(action);
      actionSent.add(callout.beat_id);
      if (action.kind === 'SET_CONTROL_MODE' && action.to === 'MANUAL') {
        manual = true;
        manualStart_s = state.clock.elapsed_s;
        // Fit the remaining clock, reserving the final six seconds for the
        // low-speed crawl and the real allocator's pulse settling.
        manualDuration_s = Math.max(1, scenario.clock.duration_s - state.clock.elapsed_s);
        manualStartY_m = telemetry?.nav_r_hill_m[1] ?? null;
        manualStartVelocityY_mps = velocity[1];
      }
    }
    if (manual) {
      simPort.setManualSubMode('PULSE');
      simPort.setManualCommand(manualCommand(
        telemetry,
        state.clock.elapsed_s - (manualStart_s ?? state.clock.elapsed_s),
        manualDuration_s,
        manualStartY_m,
        manualStartVelocityY_mps,
        velocity,
      ));
    }
  };

  return {
    step(state = director.getState(), telemetry = director.getTelemetry()) {
      act(state, telemetry);
    },
    tick(state = director.getState(), telemetry = director.getTelemetry()) {
      act(state, telemetry);
    },
  };
}

export const perfectOperatorBot = createPerfectOperatorBot;

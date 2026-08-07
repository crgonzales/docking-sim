import type { ManualCommand, TelemetryFrame, Vec3 } from '@docking/sim-core';
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
  velocity: Vec3,
): ManualCommand {
  if (telemetry === null) return { translation: [0, 1, 0], rotation: [0, 0, 0] };
  const position = telemetry.nav_r_hill_m;
  const lateralScale = telemetry.range_m < 30 ? 0.5 : 8;
  const profileDuration_s = Math.max(1, manualDuration_s);
  const accelDuration_s = profileDuration_s / 3;
  const brakingDuration_s = profileDuration_s - accelDuration_s;
  const peakVelocity_mps = 1.733425;
  const terminalVelocity_mps = 0;
  const acceleration_mps2 = peakVelocity_mps / accelDuration_s;
  const brakingAcceleration_mps2 = (terminalVelocity_mps - peakVelocity_mps) / brakingDuration_s;
  let desiredPositionY_m = position[1];
  let desiredVelocityY_mps = terminalVelocity_mps;
  let desiredAccelerationY_mps2 = 0;
  if (elapsed_s < accelDuration_s) {
    desiredPositionY_m = (startY_m ?? position[1]) + 0.5 * acceleration_mps2 * elapsed_s ** 2;
    desiredVelocityY_mps = acceleration_mps2 * elapsed_s;
    desiredAccelerationY_mps2 = acceleration_mps2;
  } else {
    const brakingTime_s = Math.min(brakingDuration_s, elapsed_s - accelDuration_s);
    desiredPositionY_m = (startY_m ?? position[1])
      + 0.5 * peakVelocity_mps * accelDuration_s
      + peakVelocity_mps * brakingTime_s
      + 0.5 * brakingAcceleration_mps2 * brakingTime_s ** 2;
    desiredVelocityY_mps = peakVelocity_mps + brakingAcceleration_mps2 * brakingTime_s;
    desiredAccelerationY_mps2 = brakingAcceleration_mps2;
  }
  // PULSE is a direct force command (40 N at full scale). The position and
  // velocity terms make the canned trajectory robust to the autopilot's
  // velocity at takeover while remaining a deterministic function of the
  // observed telemetry and scenario clock.
  const longitudinalAcceleration = position[1] > -30
    ? elapsed_s > manualDuration_s - 5
      ? -0.04
      : 0.6 * (terminalVelocity_mps + Math.sqrt(Math.max(0, 2 * 0.018 * (-9.95 - position[1]))) - velocity[1])
    : desiredAccelerationY_mps2
      + 0.08 * (desiredVelocityY_mps - velocity[1])
      + 0.004 * (desiredPositionY_m - position[1]);
  const forward = clamp(longitudinalAcceleration / 0.04, -1, 1);
  const translation: Vec3 = [
    clamp((-0.075 - position[0]) / lateralScale - velocity[0] / 0.1, -1, 1),
    forward,
    clamp(-position[2] / lateralScale - velocity[2] / 0.1, -1, 1),
  ];
  const rates = telemetry.body_rate_dps_est;
  const attitude = telemetry.q_BH_est;
  return {
    translation,
    rotation: [
      clamp(4 * attitude[1] - rates[0] / 0.5, -1, 1),
      clamp(4 * attitude[2] - rates[1] / 0.5, -1, 1),
      clamp(4 * attitude[3] - rates[2] / 0.5, -1, 1),
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
  let previousPosition: Vec3 | null = null;
  let previousTime_s: number | null = null;
  const beatsById = new Map(scenario.beats.map((beat) => [beat.id, beat]));

  const act = (state: ScenarioUiState, telemetry: TelemetryFrame | null): void => {
    if (state.phase !== 'RUNNING') return;
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
        // The profile spans the full remaining clock deliberately: PULSE
        // authority (~0.04 m/s^2) plus the <=0.10 m/s capture envelope make
        // the 90 s from B4 to T-0 physically tight - reserving margin makes
        // the terminal crawl arrive too hot and miss capture entirely.
        manualDuration_s = Math.max(1, scenario.clock.duration_s - state.clock.elapsed_s);
        manualStartY_m = telemetry?.nav_r_hill_m[1] ?? null;
      }
    }
    if (manual) {
      const velocity: Vec3 = previousPosition === null || previousTime_s === null || state.clock.elapsed_s <= previousTime_s
        ? [0, 0, 0]
        : [
            ((telemetry?.nav_r_hill_m[0] ?? 0) - previousPosition[0]) / (state.clock.elapsed_s - previousTime_s),
            ((telemetry?.nav_r_hill_m[1] ?? 0) - previousPosition[1]) / (state.clock.elapsed_s - previousTime_s),
            ((telemetry?.nav_r_hill_m[2] ?? 0) - previousPosition[2]) / (state.clock.elapsed_s - previousTime_s),
          ];
      if (telemetry !== null && (previousTime_s === null || state.clock.elapsed_s > previousTime_s)) {
        previousPosition = [...telemetry.nav_r_hill_m];
        previousTime_s = state.clock.elapsed_s;
      }
      simPort.setManualSubMode('PULSE');
      simPort.setManualCommand(manualCommand(
        telemetry,
        state.clock.elapsed_s - (manualStart_s ?? state.clock.elapsed_s),
        manualDuration_s,
        manualStartY_m,
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

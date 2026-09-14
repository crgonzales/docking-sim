import { CAPTURE_ENVELOPE, conjugateQuaternion, rotateVector, type TelemetryFrame, type Vec3 } from '@docking/sim-core';
import { CHASER_PORT_BODY, STATION_PORT_HILL } from '../scene/modelNormalization';

/** Navigation-derived port error. Positive body axes match the pilot's controls. */
export function dockingLesson(frame: TelemetryFrame | null, precision: boolean) {
  if (!frame?.docking) return null;
  const port = rotateVector(conjugateQuaternion(frame.q_BH_est), [...CHASER_PORT_BODY]);
  const delta = STATION_PORT_HILL.map((v, i) => v - frame.nav_r_hill_m[i]! - port[i]!) as Vec3;
  const body = rotateVector(frame.q_BH_est, delta);
  const gap = delta[1];
  const lateral = Math.hypot(delta[0], delta[2]);
  const d = frame.docking;
  // Aim inside the capture boundary, leaving margin for navigation error.
  const aligned = lateral <= CAPTURE_ENVELOPE.lateral_m * 0.6 && d.misalign_deg <= CAPTURE_ENVELOPE.misalign_deg;
  const stable = d.rate_dps <= CAPTURE_ENVELOPE.rate_dps;
  const speedSafe = d.closing_mps >= CAPTURE_ENVELOPE.closing_mps[0] && d.closing_mps <= CAPTURE_ENVELOPE.closing_mps[1];
  const stage = frame.outcome === 'DOCKED' ? 3 : !aligned ? 0 : gap > 2 ? 1 : 2;
  let hint = 'Hold Shift to move toward the port. Release to let the assist slow and hold.';
  if (gap < -0.1) hint = 'You passed the docking face. Retry the final 2 m to set up another approach.';
  else if (gap < 3 && d.closing_mps > 0.12) hint = 'Closing too fast. Press Space to brake, then use precision thrust for capture.';
  else if (d.misalign_deg > CAPTURE_ENVELOPE.misalign_deg) hint = 'Use W/S and A/D to aim the nose; Q/E correct roll. The port must be aligned within 4°.';
  else if (!aligned) hint = Math.abs(body[0]) >= Math.abs(body[2])
    ? `Tap ${body[0] < 0 ? 'J to slide left' : 'L to slide right'}. Bring the diamond into the centre circle.`
    : `Tap ${body[2] < 0 ? 'K to slide down' : 'I to slide up'}. Bring the diamond into the centre circle.`;
  else if (!stable) hint = 'Rotation is above the capture limit. Press Space to hold while the attitude settles.';
  else if (gap < 3 && !precision) hint = 'Press X for precision thrust before the final two metres.';
  else if (gap <= 2) hint = 'Keep holding Shift at precision speed through contact. Aim for 0.03–0.10 m/s.';
  return { gap, lateral, body, aligned, stable, speedSafe, stage, hint };
}

export function dockingFailureAdvice(frame: TelemetryFrame | null): string {
  const d = frame?.docking;
  if (!d) return 'Navigation data was unavailable at contact. Retry and check the docking camera.';
  if (d.closing_mps > CAPTURE_ENVELOPE.closing_mps[1]) return 'Your estimated closing speed was too high. Brake earlier with Space, then approach in precision mode.';
  if (dockingLesson(frame, true)!.lateral > CAPTURE_ENVELOPE.lateral_m) return 'Your estimated port offset was too large. Use I/J/K/L to centre the diamond before moving forward.';
  if (d.misalign_deg > CAPTURE_ENVELOPE.misalign_deg) return 'The estimated docking angle was outside the limit. Correct pitch, yaw and roll before contact.';
  if (d.rate_dps > CAPTURE_ENVELOPE.rate_dps) return 'Estimated rotation exceeded the capture limit. Hold position before the final approach and check the spin-rate readout.';
  if (d.closing_mps < CAPTURE_ENVELOPE.closing_mps[0]) return 'The estimated closing speed was too low. Keep a gentle forward command through contact.';
  return 'Contact was outside the physical capture limits even though the last navigation estimate looked safe. Retry with more margin on alignment and speed.';
}

import { CAPTURE_ENVELOPE, conjugateQuaternion, rotateVector, type TelemetryFrame, type Vec3 } from '@docking/sim-core';
import { CHASER_PORT_BODY, STATION_PORT_HILL } from '../scene/modelNormalization';

/** Estimated station-port offset measured from the rotated nose port, in Hill and body axes. */
export function portGeometry(frame: Pick<TelemetryFrame, 'nav_r_hill_m' | 'q_BH_est'>) {
  const port = rotateVector(conjugateQuaternion(frame.q_BH_est), [...CHASER_PORT_BODY]);
  const delta = STATION_PORT_HILL.map((v, i) => v - frame.nav_r_hill_m[i]! - port[i]!) as Vec3;
  const body = rotateVector(frame.q_BH_est, delta);
  return { delta, body, gap: delta[1], lateral: Math.hypot(delta[0], delta[2]) };
}

/** Docking-camera figures graded on the port lateral, the quantity the truth contact test uses. */
export function dockingEnvelopeReadout(frame: TelemetryFrame | null) {
  if (!frame?.docking) return null;
  const d = frame.docking;
  const lateral_m = portGeometry(frame).lateral;
  const inside = d.closing_mps >= CAPTURE_ENVELOPE.closing_mps[0] && d.closing_mps <= CAPTURE_ENVELOPE.closing_mps[1]
    && lateral_m <= CAPTURE_ENVELOPE.lateral_m && d.misalign_deg <= CAPTURE_ENVELOPE.misalign_deg && d.rate_dps <= CAPTURE_ENVELOPE.rate_dps;
  return { closing_mps: d.closing_mps, lateral_m, misalign_deg: d.misalign_deg, rate_dps: d.rate_dps, inside };
}

/** A teaching ring stays until the rotated port gap closes to its label; without navigation every ring stays. */
export function approachRingVisible(geometry: ReturnType<typeof portGeometry> | null, ringGap_m: number): boolean {
  return geometry === null || geometry.gap > ringGap_m;
}

/** Navigation-derived port error. Positive body axes match the pilot's controls. */
export function dockingLesson(frame: TelemetryFrame | null, precision: boolean) {
  if (!frame?.docking) return null;
  const { gap, lateral, body } = portGeometry(frame);
  const d = frame.docking;
  // Aim inside the capture boundary, leaving margin for navigation error.
  const aligned = lateral <= CAPTURE_ENVELOPE.lateral_m * 0.6 && d.misalign_deg <= CAPTURE_ENVELOPE.misalign_deg;
  const stable = d.rate_dps <= CAPTURE_ENVELOPE.rate_dps;
  const speedSafe = d.closing_mps >= CAPTURE_ENVELOPE.closing_mps[0] && d.closing_mps <= CAPTURE_ENVELOPE.closing_mps[1];
  const stage = frame.outcome === 'DOCKED' ? 3 : !aligned ? 0 : gap > 2 ? 1 : 2;
  let hint = 'Hold Shift to move toward the port. Release to let the assist slow and hold.';
  if (typeof frame.corridor_err_m === 'number' && frame.corridor_err_m > 0) hint = 'You are drifting outside the approach corridor. Slide back toward the docking axis before moving forward.';
  else if (gap < -0.1) hint = 'You passed the docking face. Retry the final 2 m to set up another approach.';
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

/** The lesson's only abort path is the corridor monitor; explain that ending with the last estimate. */
export function dockingAbortAdvice(frame: TelemetryFrame | null): string {
  const base = 'The approach drifted outside the safe corridor around the docking axis, so the safety monitor aborted to a passive coast.';
  if (!frame) return `${base} Retry and keep the diamond centred before moving forward.`;
  const { gap, lateral } = portGeometry(frame);
  return `${base} The last estimate put the port ${lateral.toFixed(2)} m off axis with ${Math.max(0, gap).toFixed(1)} m to contact. Retry, use I/J/K/L to centre the diamond, then approach.`;
}

export const PRACTICE_EXPIRY_ADVICE = 'The 20-minute practice limit ended before contact. Nothing failed: retry the approach, or practise the final 2 m to rehearse the capture.';

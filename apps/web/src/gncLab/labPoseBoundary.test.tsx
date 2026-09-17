import * as React from 'react';
import { Group, Quaternion, Vector3 } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { Spacecraft } from '../scene/Spacecraft';
import { WorldFrame } from '../scene/worldFrame';
import { useTelemetryBus } from '../telemetry/bus';
import { createLabSession } from './session/labSession';
import { NOMINAL_CASE } from './session/demoRun';

// Invoke the actual Chaser frame callback with real Three transforms. Only
// React/R3F scheduling is replaced; no copy of the pose-update math is tested.
const hooks = vi.hoisted(() => ({ index: 0, refs: [] as { current: unknown }[],
  frame: null as null | ((state: unknown, dt: number) => void) }));
vi.mock('react', async original => ({ ...await original<typeof React>(),
  useRef: (initial: unknown) => hooks.refs[hooks.index++] ?? (hooks.refs[hooks.index - 1] = { current: initial }),
}));
vi.mock('@react-three/fiber', () => ({ useFrame: (frame: typeof hooks.frame) => { hooks.frame = frame; }, useLoader: vi.fn(), useThree: vi.fn() }));
vi.mock('@react-three/drei', () => ({ useGLTF: Object.assign(vi.fn(), { preload: vi.fn() }) }));
vi.mock('../telemetry/bus', async original => {
  const actual = await original<typeof import('../telemetry/bus')>();
  return { ...actual, useTelemetryBus: Object.assign(
    (select: (state: ReturnType<typeof actual.useTelemetryBus.getState>) => unknown) => select(actual.useTelemetryBus.getState()), actual.useTelemetryBus) };
});

function elements(root: React.ReactNode): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  React.Children.forEach(root, child => {
    if (React.isValidElement<{ children?: React.ReactNode }>(child)) found.push(child, ...elements(child.props.children));
  });
  return found;
}
afterEach(() => { hooks.refs = []; hooks.index = 0; hooks.frame = null; useTelemetryBus.setState({ gnc: null, renderState: null }); });

function harness() {
  const world = new WorldFrame([100, 200, -50], { metersPerUnit: 10 });
  const child = elements(Spacecraft({ worldFrame: world })).find(el => typeof el.type === 'function' && el.type.name === 'Chaser')!;
  hooks.refs = [];
  const group = new Group();
  const render = () => { hooks.index = 0; (child.type as React.FunctionComponent)(child.props); hooks.refs[0].current = group; };
  const run = createLabSession(NOMINAL_CASE, { runId: 'pose', epoch: 1, poseEpoch: 1 });
  const tick = run.snapshot(); run.dispose();
  const pose = { ...tick.renderState, r_hill_m: [120, 180, -20] as [number, number, number],
    q_BH: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number] };
  const publish = (epoch: number, live = true) => { useTelemetryBus.setState({ renderState: pose, poseEpoch: epoch,
    gnc: live ? { ...tick, renderState: pose, poseEpoch: epoch } : null }); render(); };
  return { world, group, publish, render, pose, frame: (dt: number) => hooks.frame!(null, dt) };
}

it('snaps both position and inverse body attitude on GNC entry, step and reset, including a rebase', () => {
  const h = harness();
  h.publish(1); h.frame(0);
  expect(h.group.position.toArray()).toEqual([2, -2, 3]);
  h.group.quaternion.toArray().forEach((value, i) => expect(value).toBeCloseTo([0, 0, -Math.SQRT1_2, Math.SQRT1_2][i], 14));
  // Inverse attitude rotates body +X to Hill -Y, not Hill +Y.
  expect(new Vector3(1, 0, 0).applyQuaternion(h.group.quaternion).distanceTo(new Vector3(0, -1, 0))).toBeLessThan(1e-14);
  for (const epoch of [2, 3]) {
    h.group.position.set(99, 99, 99); h.group.quaternion.identity();
    if (epoch === 3) h.world.setAnchor([110, 170, -30]);
    h.publish(epoch); h.frame(0);
    expect(h.group.position.toArray()).toEqual(epoch === 3 ? [1, 1, 1] : [2, -2, 3]);
    h.group.quaternion.toArray().forEach((value, i) => expect(value).toBeCloseTo([0, 0, -Math.SQRT1_2, Math.SQRT1_2][i], 14));
  }
});

it('keeps smoothing between GNC discontinuities and ignores retained GNC epochs in ordinary play', () => {
  const h = harness(); h.publish(5); h.frame(0);
  for (const live of [true, false]) {
    h.group.position.set(0, 0, 0); h.group.quaternion.identity();
    h.publish(live ? 5 : 99, live); h.frame(0);
    expect(h.group.position.toArray()).toEqual([0, 0, 0]);
    expect(h.group.quaternion.toArray()).toEqual(new Quaternion().toArray());
    h.frame(.1);
    expect(h.group.position.x).toBeGreaterThan(0); expect(h.group.position.x).toBeLessThan(2);
    expect(h.group.quaternion.angleTo(new Quaternion(0, 0, -Math.SQRT1_2, Math.SQRT1_2))).toBeGreaterThan(0);
  }
});

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { Group, Quaternion, Raycaster, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CREW_DRAGON_THRUSTERS, CREW_DRAGON_SCALE, CREW_DRAGON_OFFSET_Y, CREW_DRAGON_DOCK_SOURCE_Y,
  createAllocator, createSimLoop, type Vec3 } from '@docking/sim-core';
import { boundedThrusterDuty, THRUSTER_NOZZLES } from './thrusterPresentation';
import { SIM_CONFIG, SIM_SEED } from '../telemetry/simEmitter';

let model: Group;
beforeAll(async () => {
  const data = await readFile(new URL('../../public/assets/models/dragon/crew-dragon.glb', import.meta.url));
  const asset = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '');
  model = asset.scene;
  const nose = model.getObjectByName('Circle001_2')!;
  const track = asset.animations[0]!.tracks.find(t => t.name === 'Circle001_2.quaternion')!;
  nose.quaternion.fromArray(track.createInterpolant().evaluate(7));
  model.scale.setScalar(CREW_DRAGON_SCALE); model.position.y = CREW_DRAGON_OFFSET_Y;
  model.updateMatrixWorld(true);
});

describe('Dragon RCS registration', () => {
  it('places every exhaust outside the loaded vehicle with an unobstructed thrust axis', () => {
    for (const nozzle of THRUSTER_NOZZLES) {
      const ray = new Raycaster(new Vector3(...nozzle.exit), new Vector3(...nozzle.exhaust), 0.005, 5);
      const hits = ray.intersectObject(model, true);
      expect(hits.map(hit => ({ name: hit.object.name, distance: hit.distance })), nozzle.id).toEqual([]);
    }
  });
  it('keeps separate mouth openings clear and the docking face at the contact datum', () => {
    expect(CREW_DRAGON_DOCK_SOURCE_Y * CREW_DRAGON_SCALE + CREW_DRAGON_OFFSET_Y).toBeCloseTo(1.7, 12);
    for (let i = 0; i < THRUSTER_NOZZLES.length; i++) for (let j = i + 1; j < THRUSTER_NOZZLES.length; j++) {
      const a = THRUSTER_NOZZLES[i]!, b = THRUSTER_NOZZLES[j]!;
      expect(new Vector3(...a.exit).distanceTo(new Vector3(...b.exit)), `${a.id}/${b.id}`)
        .toBeGreaterThan(a.radiusM + b.radiusM + 0.03);
    }
  });
  it('uses the same position/axis for force, torque and exhaust through craft rotations', () => {
    const craft = new Quaternion().setFromAxisAngle(new Vector3(1, 2, -3).normalize(), 1.3);
    for (const [i, nozzle] of THRUSTER_NOZZLES.entries()) {
      const spec = CREW_DRAGON_THRUSTERS[i]!;
      expect(nozzle.exit).toEqual(spec.position_body_m);
      const drawn = new Vector3(0, 1, 0).applyQuaternion(new Quaternion().setFromUnitVectors(
        new Vector3(0, 1, 0), new Vector3(...nozzle.exhaust))).applyQuaternion(craft);
      const force = new Vector3(...spec.direction_body).applyQuaternion(craft);
      expect(drawn.dot(force)).toBeCloseTo(-1, 9);
    }
  });
  it('can allocate translation and rotation in both directions with the imported layout', () => {
    const allocator = createAllocator({ specs: CREW_DRAGON_THRUSTERS });
    for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
      const demand: Vec3 = [0, 0, 0]; demand[axis] = sign * 5;
      const force = allocator.allocate(demand, [0, 0, 0]);
      const torque = allocator.allocate([0, 0, 0], demand);
      expect(Math.hypot(...force.solveResidual_N)).toBeLessThan(0.25);
      expect(Math.hypot(...force.solveTorqueResidual_Nm)).toBeLessThan(0.25);
      expect(Math.hypot(...torque.solveResidual_N)).toBeLessThan(0.25);
      expect(Math.hypot(...torque.solveTorqueResidual_Nm)).toBeLessThan(0.25);
    }
  });
  it('exposes actual stuck-open firing even when the commanded jet is zero', () => {
    const sim = createSimLoop(SIM_CONFIG, SIM_SEED);
    sim.setControlMode('MANUAL'); sim.setManualCommand({ translation: [0, 0, 0], rotation: [0, 0, 0] });
    CREW_DRAGON_THRUSTERS.forEach(jet => sim.isolateThruster(jet.id));
    sim.injectThrusterStuck('J1', 'OPEN');
    const frames = sim.stepTo(0.1);
    expect(frames.at(-1)!.thruster_duty.J1).toBe(0);
    expect(sim.getRenderState().thruster_duty.J1).toBeCloseTo(1);
    expect(sim.getTruthState().prop_kg).toBeLessThan(24);
  });
  it('does not invent firing for absent, negative or nonfinite duty', () => {
    for (const value of [undefined, NaN, Infinity, -1, 0]) expect(boundedThrusterDuty(value)).toBe(0);
    expect(boundedThrusterDuty(0.2)).toBe(0.2); expect(boundedThrusterDuty(4)).toBe(1);
  });
});

import { BLOCKS, type BlockDescriptor } from './blocks';
import { inputFrom, OUTPUT_PORTS, type PortDescriptor } from './ports';
import { immutable } from './tracePaths';

export interface EdgeDescriptor {
  readonly id: string; readonly from: string; readonly to: string; readonly delayed: boolean;
  readonly delay?: 'PREVIOUS_FSW_WINDOW' | 'PHYSICAL_INTEGRATION';
  readonly transform?: 'HILL->BODY' | 'BODY->HILL' | 'ECI->HILL';
  readonly transformBlock?: string;
  readonly transformSource?: { readonly module: string; readonly symbol: 'rotateVector' | 'hillToBody' };
  readonly note?: string;
}
export interface GncGraph {
  readonly blocks: readonly BlockDescriptor[]; readonly ports: readonly PortDescriptor[]; readonly edges: readonly EdgeDescriptor[];
}
const ports = [...OUTPUT_PORTS];
const edges: EdgeDescriptor[] = [];
function connect(from: string, block: string, name?: string, overrides: Partial<PortDescriptor> = {},
  edge: Partial<EdgeDescriptor> = {}): void {
  const source = OUTPUT_PORTS.find(p => p.id === from);
  if (!source) throw new Error(`Unknown graph output ${from}`);
  const target = inputFrom(source, block, name, overrides);
  ports.push(target);
  edges.push({ id: `${from}->${target.id}`, from, to: target.id, delayed: false, ...edge });
}

connect('plant.truth/out/position', 'sensors.suite', 'truthSample',
  { trace: 'sampledPlantTick.truth.r_hill_m', rate: 'FSW_10HZ', sampled: true },
  { delayed: true, delay: 'PHYSICAL_INTEGRATION', note: 'Sensor boundary samples the full integrated plant state; position is its representative signal.' });
for (const name of ['position', 'velocity', 'attitude', 'rate']) connect(`plant.truth/out/${name}`, 'plant.contact');
for (const name of ['gyroMean', 'starTracker']) connect(`sensors.suite/out/${name}`, 'nav.mekf');
connect('nav.mekf/out/attitude', 'nav.frames');
connect('nav.frames/out/attitude', 'nav.ekf');
for (const name of ['range', 'bearing']) connect(`sensors.suite/out/${name}`, 'nav.ekf');
connect('guidance.vbar/out/velocity', 'nav.ekf', 'velocityReference');
connect('alloc.jets/out/onTimes', 'nav.feedforward', 'previousOnTimes', { trace: 'previousFsw.allocation.onTimes' },
  { delayed: true, delay: 'PREVIOUS_FSW_WINDOW', note: 'Previous on-times and previous q_HB, one FSW window; bootstrap input is absent.' });
connect('nav.feedforward/out/specificForce', 'nav.ekf');
for (const block of ['safety.corridor', 'safety.abort', 'control.pid', 'control.lqr', 'control.mpc']) {
  for (const name of ['position', 'velocity']) connect(`nav.ekf/out/${name}`, block);
}
for (const block of ['control.pid', 'control.lqr']) {
  for (const name of ['position', 'velocity']) connect(`guidance.vbar/out/${name}`, block, `${name}Reference`,
    { when: OUTPUT_PORTS.find(p => p.id === `${block}/out/force`)!.when });
  connect(`${block}/out/force`, 'fsw.modeSwitch', block);
}
connect('control.mpc/out/acceleration', 'fsw.modeSwitch', 'mpcAcceleration', { rate: 'FSW_10HZ' });
connect('safety.corridor/out/abortTrigger', 'safety.abort');
connect('safety.abort/out/state', 'fsw.modeSwitch', 'abortState');
connect('safety.abort/out/targetVelocity', 'fsw.modeSwitch');
connect('pilot.manual/out/translation', 'fsw.modeSwitch');
connect('pilot.manual/out/rotation', 'control.attitude');
connect('nav.mekf/out/attitude', 'control.attitude');
connect('nav.mekf/out/rate', 'control.attitude');
connect('control.attitude/out/torque', 'alloc.jets');
connect('fsw.modeSwitch/out/forceHill', 'alloc.jets', 'forceBody', { frame: 'BODY', trace: 'fsw.command.force_body_N' },
  { transform: 'HILL->BODY', transformBlock: 'fsw.modeSwitch', transformSource: { module: 'fsw.ts', symbol: 'rotateVector' } });
connect('alloc.jets/out/onTimes', 'plant.thrusters', 'heldCommand', { rate: 'TRUTH_100HZ', held: true },
  { note: 'Held command for (samplePlantTick, samplePlantTick + 10]; not the preceding delivered window.' });
connect('plant.thrusters/out/impulseHill', 'plant.truth', 'windowImpulseDiagnostic', {},
  { note: 'Integrated window diagnostic of the physical response, NOT an RK4 input. RK4 consumes 100 Hz slices; no slice is substituted for a window.' });

/** Observation model only. Nothing executing the simulation imports this graph. */
export const GRAPH_NOTICE = 'LAYOUT ONLY — execution graph is fixed';
export const GNC_GRAPH: GncGraph = immutable({ blocks: BLOCKS, ports, edges });

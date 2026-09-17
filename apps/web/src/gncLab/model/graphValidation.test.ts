import { describe, expect, it } from 'vitest';
import { GNC_GRAPH, type GncGraph } from './graph';
import { validateGraph, type GraphValidationRule } from './graphValidation';
import { inputFrom, type PortDescriptor } from './ports';

const target = 'nav.ekf/in/range';
const changePort = (id: string, patch: Partial<PortDescriptor>): GncGraph => ({ ...GNC_GRAPH,
  ports: GNC_GRAPH.ports.map(p => p.id === id ? { ...p, ...patch } : p) });
const rules = (graph: GncGraph) => validateGraph(graph).map(i => i.rule);

describe('GNC graph validation', () => {
  it('accepts the shipped graph and names exactly its two physical delays', () => {
    expect(validateGraph(GNC_GRAPH)).toEqual([]);
    expect(GNC_GRAPH.edges.filter(e => e.delayed).map(e => [
      GNC_GRAPH.ports.find(p => p.id === e.from)!.block,
      GNC_GRAPH.ports.find(p => p.id === e.to)!.block, e.delay,
    ])).toEqual([
      ['plant.truth', 'sensors.suite', 'PHYSICAL_INTEGRATION'],
      ['alloc.jets', 'nav.feedforward', 'PREVIOUS_FSW_WINDOW'],
    ]);
  });
  it.each<[GraphValidationRule, Partial<PortDescriptor>]>([
    ['TYPE', { dataType: 'boolean' }], ['DIMENSION', { dims: [2] }],
    ['UNIT', { unit: 's' }], ['FRAME', { frame: 'BODY' }],
    ['RATE', { rate: 'TRUTH_100HZ' }], ['PROVENANCE', { provenance: 'TRUTH' }],
  ])('rejects a crafted %s mismatch', (rule, patch) => {
    expect(rules(changePort(target, patch))).toContain(rule);
  });
  it('rejects a real algebraic cycle and does not accept an invented delay to hide it', () => {
    const source = GNC_GRAPH.ports.find(p => p.id === 'nav.ekf/out/position')!;
    const input = inputFrom(source, 'nav.feedforward', 'cycle');
    const edge = { id: 'cycle', from: source.id, to: input.id, delayed: false };
    const graph = { ...GNC_GRAPH, ports: [...GNC_GRAPH.ports, input], edges: [...GNC_GRAPH.edges, edge] };
    expect(rules(graph)).toContain('ALGEBRAIC_CYCLE');
    expect(rules({ ...graph, edges: [...GNC_GRAPH.edges, { ...edge, delayed: true, delay: 'PHYSICAL_INTEGRATION' }] })).toContain('ALGEBRAIC_CYCLE');
    for (const delay of GNC_GRAPH.edges.filter(e => e.delayed)) {
      expect(rules({ ...GNC_GRAPH, edges: GNC_GRAPH.edges.map(e => e === delay ? { ...e, delayed: false, delay: undefined } : e) })).toContain('ALGEBRAIC_CYCLE');
    }
  });
  it('checks frame-transform direction and its actual call site', () => {
    const transformed = GNC_GRAPH.edges.find(e => e.transform)!;
    for (const patch of [{ transform: undefined }, { transform: 'BODY->HILL' as const },
      { transformBlock: 'missing' }, { transformSource: { module: 'invented.ts', symbol: 'rotateVector' as const } }]) {
      expect(rules({ ...GNC_GRAPH, edges: GNC_GRAPH.edges.map(e => e === transformed ? { ...e, ...patch } : e) })).toContain('FRAME');
    }
  });
  it('requires the receiver sample/hold marker; MPC calls still occur at 10 Hz', () => {
    expect(rules(changePort('sensors.suite/in/truthSample', { sampled: false }))).toContain('RATE');
    expect(rules(changePort('plant.thrusters/in/heldCommand', { held: false }))).toContain('RATE');
    expect(rules(changePort(target, { rate: 'EVENT', held: true }))).toContain('RATE');
    expect(rules(changePort(target, { rate: 'MPC_1HZ_IN_10HZ' }))).not.toContain('RATE');
  });
  it('rejects predicted-as-actual, privileged FSW inputs and false trace roots', () => {
    expect(rules(changePort('alloc.jets/out/forcePredicted', { provenance: 'DELIVERED' }))).toContain('PROVENANCE');
    expect(rules(changePort(target, { trace: 'plantTick.truth.prop_kg', provenance: 'TRUTH' }))).toContain('PROVENANCE');
    for (const trace of ['fsw.command.force_body_N', 'fsw.allocation.achievedForce_N', 'plantTick.slice.force_body_N'] as const) {
      expect(rules(changePort('plant.thrusters/out/impulseBody', { trace }))).toContain('PROVENANCE');
    }
    expect(rules(changePort('plant.thrusters/out/impulseBody', { trace: 'pendingWindow.impulse_body_Ns' }))).not.toContain('PROVENANCE');
  });
  it('rejects dangling endpoints, duplicate ids, malformed dimensions, units and enum dictionaries', () => {
    expect(rules({ ...GNC_GRAPH, edges: [...GNC_GRAPH.edges, { id: 'bad', from: 'missing', to: target, delayed: false }] })).toContain('TYPE');
    expect(rules({ ...GNC_GRAPH, ports: [...GNC_GRAPH.ports, GNC_GRAPH.ports[0]] })).toContain('TYPE');
    expect(rules(changePort(target, { dims: [0] }))).toContain('DIMENSION');
    expect(rules(changePort(target, { unit: 'deg' }))).toContain('UNIT');
    expect(rules(changePort('safety.abort/in/abortTrigger', { direction: 'OUT' }))).toContain('TYPE');
    expect(rules(changePort('fsw.modeSwitch/in/abortState', { enumValues: ['wrong'] }))).toContain('TYPE');
  });
  it('returns issues in the seven-rule contract order', () => {
    const result = validateGraph(changePort(target, { dataType: 'quaternion', dims: [2], unit: 'deg', frame: 'BODY', rate: 'EVENT', provenance: 'DELIVERED' }));
    expect([...new Set(result.map(i => i.rule))]).toEqual(['TYPE', 'DIMENSION', 'UNIT', 'FRAME', 'RATE', 'PROVENANCE']);
  });
});

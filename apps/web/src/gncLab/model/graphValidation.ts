import type { GncGraph } from './graph';
import { traceProvenance } from './tracePaths';

export type GraphValidationRule = 'TYPE' | 'DIMENSION' | 'UNIT' | 'FRAME' | 'RATE' | 'ALGEBRAIC_CYCLE' | 'PROVENANCE';
export interface GraphValidationIssue { readonly rule: GraphValidationRule; readonly id: string; readonly message: string }
const RULES: readonly GraphValidationRule[] = ['TYPE', 'DIMENSION', 'UNIT', 'FRAME', 'RATE', 'ALGEBRAIC_CYCLE', 'PROVENANCE'];
const SI_UNITS = new Set(['1', 'm', 'm/s', 'rad', 'rad/s', 'N', 'N*m', 's', 'kg', 'm/s^2', 'm^2', 'm^2/s^2', 'rad^2', 'rad^2/s^2', 'N*s', 'N*m*s']);
const rates = { TRUTH_100HZ: 100, FSW_10HZ: 10, MPC_1HZ_IN_10HZ: 10, EVENT: 0 };

/** Static validation of descriptors, never permission to change simulation execution. */
export function validateGraph(graph: GncGraph): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const fail = (rule: GraphValidationRule, id: string, message: string) => { issues.push({ rule, id, message }); };
  const blocks = new Map(graph.blocks.map(b => [b.id, b]));
  const ports = new Map(graph.ports.map(p => [p.id, p]));
  for (const [label, items] of [['block', graph.blocks], ['port', graph.ports], ['edge', graph.edges]] as const) {
    const seen = new Set<string>();
    for (const item of items) { if (seen.has(item.id)) fail('TYPE', item.id, `Duplicate ${label} id`); seen.add(item.id); }
  }
  for (const p of graph.ports) {
    if (!blocks.has(p.block) || !['IN', 'OUT'].includes(p.direction) || !['double', 'boolean', 'enum', 'quaternion'].includes(p.dataType)) fail('TYPE', p.id, 'Invalid block, direction or data type');
    if (p.dataType === 'enum' && (!p.enumValues?.length || new Set(p.enumValues).size !== p.enumValues.length)) fail('TYPE', p.id, 'Enum needs a fixed, unique value dictionary');
    if (![1, 2].includes(p.dims.length) || p.dims.some(d => !Number.isInteger(d) || d <= 0)
      || (p.components && p.components.length !== p.dims.reduce((a, b) => a * b, 1))
      || (p.dataType === 'quaternion' && (p.dims.length !== 1 || p.dims[0] !== 4))) fail('DIMENSION', p.id, 'Invalid dimensions or component selection');
    if (!SI_UNITS.has(p.unit)) fail('UNIT', p.id, 'Unit must be an explicit supported SI unit');
    if (!['HILL', 'BODY', 'ECI', 'JET', 'NONE'].includes(p.frame)) fail('FRAME', p.id, 'Unknown frame');
    if (!Object.hasOwn(rates, p.rate)) fail('RATE', p.id, 'Unknown rate');
    if (traceProvenance(p.trace) !== p.provenance) fail('PROVENANCE', p.id, 'Provenance disagrees with the actual trace root');
    if (p.direction === 'IN' && p.provenance === 'TRUTH' && !blocks.get(p.block)?.truth) fail('PROVENANCE', p.id, 'Truth may enter only the physical plant or sensor boundary');
  }
  const adjacency = new Map(graph.blocks.map(b => [b.id, [] as string[]]));
  for (const e of graph.edges) {
    const from = ports.get(e.from), to = ports.get(e.to);
    if (!from || !to || from.direction !== 'OUT' || to.direction !== 'IN') { fail('TYPE', e.id, 'Edge requires an existing OUT → IN pair'); continue; }
    if (from.dataType !== to.dataType) fail('TYPE', e.id, 'Data types differ');
    if (from.dataType === 'enum' && JSON.stringify(from.enumValues) !== JSON.stringify(to.enumValues)) fail('TYPE', e.id, 'Enum dictionaries differ');
    if (JSON.stringify(from.dims) !== JSON.stringify(to.dims)) fail('DIMENSION', e.id, 'Dimensions differ');
    if (from.unit !== to.unit) fail('UNIT', e.id, 'Units differ; implicit conversion is forbidden');
    const transformValid = e.transform === `${from.frame}->${to.frame}` && blocks.has(e.transformBlock ?? '')
      && ((e.transform === 'ECI->HILL' && e.transformBlock === 'nav.frames' && e.transformSource?.module === 'attitude.ts' && e.transformSource.symbol === 'hillToBody')
        || (['HILL->BODY', 'BODY->HILL'].includes(e.transform ?? '') && ['fsw.modeSwitch', 'nav.feedforward'].includes(e.transformBlock ?? '')
          && e.transformSource?.module === 'fsw.ts' && e.transformSource.symbol === 'rotateVector'));
    if ((from.frame !== to.frame || e.transform !== undefined) && !transformValid) fail('FRAME', e.id, 'Frame change requires the matching transform and real call site');
    const a = rates[from.rate], b = rates[to.rate];
    if (a !== b && !(a === 100 && b === 10 && to.sampled === true) && !(a === 10 && b === 100 && to.held === true)) fail('RATE', e.id, 'Rate change requires explicit sampling or hold');
    const declaredDelay = (from.block === 'alloc.jets' && to.block === 'nav.feedforward' && e.delay === 'PREVIOUS_FSW_WINDOW')
      || (from.block === 'plant.truth' && to.block === 'sensors.suite' && e.delay === 'PHYSICAL_INTEGRATION');
    if ((e.delayed && !declaredDelay) || (!e.delayed && e.delay !== undefined)) fail('ALGEBRAIC_CYCLE', e.id, 'Delay must name an implemented physical or previous-command boundary');
    if (!e.delayed) adjacency.get(from.block)?.push(to.block);
    if (from.provenance !== to.provenance) fail('PROVENANCE', e.id, 'An edge cannot relabel a signal');
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { fail('ALGEBRAIC_CYCLE', id, 'Cycle in non-delayed subgraph'); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    visiting.delete(id); visited.add(id);
  };
  graph.blocks.forEach(b => visit(b.id));
  return issues.sort((a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
}

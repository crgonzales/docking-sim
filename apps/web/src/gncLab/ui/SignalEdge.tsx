import { GNC_GRAPH, type EdgeDescriptor } from '../model/graph';
import { RATE_LABELS } from '../model/blocks';

/** Only real model edges are drawn; diagram stage order is not a wiring claim. */
export function SignalEdge({ edge }: { edge: EdgeDescriptor }) {
  const from = GNC_GRAPH.ports.find(port => port.id === edge.from)!;
  const to = GNC_GRAPH.ports.find(port => port.id === edge.to)!;
  const label = (id: string) => GNC_GRAPH.blocks.find(block => block.id === id)!.label;
  return <div className="gnc-edge" data-edge-id={edge.id}>
    <span>{label(from.block)} · {from.name}</span>
    <svg viewBox="0 0 32 12" aria-label="feeds" role="img"><path d="M0 6H30M24 1L30 6L24 11" /></svg>
    <span>{label(to.block)} · {to.name}</span>
    <small>{RATE_LABELS[from.rate]} · {from.unit} · {from.frame}
      {edge.transform && ` · ${edge.transform}`}{to.sampled && ' · SAMPLED'}{to.held && ' · HELD'}
      {edge.delay === 'PREVIOUS_FSW_WINDOW' && ' · PREVIOUS FSW WINDOW'}
      {edge.delay === 'PHYSICAL_INTEGRATION' && ' · PHYSICAL INTEGRATION'}</small>
    {edge.note && <small>{edge.note}</small>}
  </div>;
}

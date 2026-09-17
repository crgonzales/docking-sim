import type { ProvenanceClass } from '../model/tracePaths';
import { displayUnit, formatReading, formatSampleAge, formatSampleTime } from './format';

export type ProvenanceLabel = ProvenanceClass;
const PROVENANCE_TEXT: Record<ProvenanceClass, string> = {
  MEASUREMENT: 'MEASUREMENT', ESTIMATE: 'ESTIMATE', REFERENCE: 'REFERENCE', COMMAND: 'COMMAND',
  ALLOCATED: 'ALLOCATED · MODEL', DELIVERED: 'DELIVERED · PLANT', TRUTH: 'TRUTH · COMPARISON',
};
export interface BlockReading {
  label: string; value: number | null; unit: string; frame?: string;
  digits?: number; unavailableStatus?: string;
}
export interface BlockSample {
  t_s: number | null; age_s: number | null; hold?: 'HELD' | 'PENDING'; detail?: string;
}
export interface BlockCondition { level: 'caution' | 'warning'; text: string }
export interface BlockNodeProps {
  id: string; title: string; provenance: ProvenanceClass; rateLabel: string;
  readings: readonly BlockReading[]; sample: BlockSample; condition?: BlockCondition | null;
  selected: boolean; onSelect: (id: string) => void;
}
/** Stateless view of descriptor-selected, stamped observations. No local clocks. */
export function BlockNode({ id, title, provenance, rateLabel, readings, sample, condition, selected, onSelect }: BlockNodeProps) {
  return <button type="button" className={`gnc-block${selected ? ' gnc-block--selected' : ''}`}
    data-block-id={id} data-provenance={provenance} data-condition={condition?.level}
    aria-pressed={selected} aria-label={`${title}, ${PROVENANCE_TEXT[provenance]}`}
    onClick={() => onSelect(id)}>
    <span className="gnc-block-title">{title}</span>
    <span className="gnc-block-provenance">{PROVENANCE_TEXT[provenance]}</span>
    <span className="gnc-block-readings">{readings.map(reading => {
      const shown = formatReading({ ...reading, si: true });
      return <span className="gnc-reading" key={reading.label}>
        <span className="gnc-reading-label">{reading.label}</span>
        <span className="gnc-reading-value">{shown.number}</span>
        <span className="gnc-reading-unit">{displayUnit(reading.unit, true)} · {reading.frame ?? 'NONE'}</span>
      </span>;
    })}</span>
    <span className="gnc-block-foot">
      <span>{rateLabel}</span>
      <span>Sample {formatSampleTime(sample.t_s)}{sample.age_s !== null ? ` · ${formatSampleAge(sample.age_s)}` : ''}
        {sample.hold ? ` · ${sample.hold}` : ''}</span>
      {sample.detail && <span>{sample.detail}</span>}
    </span>
    {condition && <span className="gnc-condition">{condition.text}</span>}
  </button>;
}

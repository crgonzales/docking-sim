import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface HistogramProps {
  title: string;
  labels: string[];
  values: number[];
  color?: string;
}

/** Small categorical bar chart used by the Monte Carlo summary. */
export function Histogram({ title, labels, values, color = '#46e08a' }: HistogramProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const chart = new uPlot({
      width: container.clientWidth || 420,
      height: 190,
      scales: { x: { time: false } },
      series: [
        {},
        {
          label: title,
          stroke: color,
          fill: color,
          paths: uPlot.paths.bars!({ size: [0.7, 100] }),
        },
      ],
      axes: [
        {
          values: (_plot, ticks) => ticks.map((tick) => labels[tick] ?? ''),
        },
        {},
      ],
    }, [labels.map((_label, index) => index), values], container);
    return () => chart.destroy();
  }, [color, labels, title, values]);

  return (
    <section className="analysis-chart" aria-label={title}>
      <h3>{title}</h3>
      <div ref={containerRef} />
    </section>
  );
}

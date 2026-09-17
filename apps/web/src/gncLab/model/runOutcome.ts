import type { SimOutcome } from '@docking/sim-core';
import type { GncTick } from '../../telemetry/bus';

/** Plant records precede FSW at a shared boundary; FSW can latch ABORT afterward.
 * Read the coherent completed telemetry too, without changing either record.
 * A control branch alone is not an outcome. */
export function runOutcome(tick: Pick<GncTick, 'plantTickRecord' | 'frame'> | null): SimOutcome | null {
  const plant = tick?.plantTickRecord?.outcome;
  if (plant && plant !== 'NONE') return plant;
  return tick?.frame?.outcome ?? plant ?? null;
}

import { describe, expect, it } from 'vitest';
import { createRng, deriveSeed } from './rng.js';

describe('seeded RNG', () => {
  it('is deterministic and keeps named streams independent', () => {
    const first = createRng(0xdecafbad);
    const second = createRng(0xdecafbad);
    expect(Array.from({ length: 8 }, () => first.next())).toEqual(
      Array.from({ length: 8 }, () => second.next()),
    );

    const range = createRng(42);
    const sensors = range.substream('sensors.range');
    range.next();
    const sensorsAfterParentUse = range.substream('sensors.range');
    const gyro = range.substream('sensors.gyro');
    expect(deriveSeed(42, 'sensors.range')).not.toBe(deriveSeed(42, 'sensors.gyro'));
    expect(Array.from({ length: 4 }, () => sensors.next())).toEqual(
      Array.from({ length: 4 }, () => sensorsAfterParentUse.next()),
    );
    expect(Array.from({ length: 4 }, () => sensors.next())).not.toEqual(
      Array.from({ length: 4 }, () => gyro.next()),
    );
  });

  it('produces reproducible Box-Muller gaussian samples', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const samplesA = Array.from({ length: 32 }, () => a.gaussian(3, 2));
    const samplesB = Array.from({ length: 32 }, () => b.gaussian(3, 2));
    expect(samplesA).toEqual(samplesB);
    expect(samplesA.every(Number.isFinite)).toBe(true);
    expect(() => a.gaussian(0, -1)).toThrow(RangeError);
  });
});

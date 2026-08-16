import { describe, expect, it } from 'vitest';
import type { BrandId, Direction } from '../types';
import { decodeSlot, encodeSlot } from './slot';

describe('encodeSlot', () => {
  it('matches a real device capture byte-for-byte', () => {
    expect(
      encodeSlot({
        direction: 'charge',
        powerW: 800,
        brand: 'jet',
        field7: 5,
        chargeSoc: 80,
        dischargeSoc: 10,
      })
    ).toBe('1,00:00,23:59,-800,0,6,5,0,0,80,10');
  });

  it('encodes discharge as a positive field 3', () => {
    expect(
      encodeSlot({
        direction: 'discharge',
        powerW: 800,
        brand: 'jet',
        field7: 5,
        chargeSoc: 80,
        dischargeSoc: 10,
      })
    ).toBe('1,00:00,23:59,800,0,6,5,0,0,80,10');
  });

  it('encodes idle as all zeros with the soc fields preserved', () => {
    expect(
      encodeSlot({
        direction: 'idle',
        powerW: 0,
        brand: 'jet',
        field7: 5,
        chargeSoc: 90,
        dischargeSoc: 15,
      })
    ).toBe('0,00:00,00:00,0,0,0,0,0,0,90,15');
  });

  it('forces the idle slot when powerW is 0 regardless of direction', () => {
    expect(
      encodeSlot({
        direction: 'charge',
        powerW: 0,
        brand: 'jet',
        field7: 5,
        chargeSoc: 90,
        dischargeSoc: 15,
      })
    ).toBe('0,00:00,00:00,0,0,0,0,0,0,90,15');
  });

  it('puts 0 in field 6 for aeg while other brands put field7', () => {
    const aeg = encodeSlot({
      direction: 'charge',
      powerW: 500,
      brand: 'aeg',
      field7: 5,
      chargeSoc: 80,
      dischargeSoc: 10,
    });
    expect(aeg).toBe('1,00:00,23:59,-500,0,6,0,0,0,80,10');

    const other = encodeSlot({
      direction: 'charge',
      powerW: 500,
      brand: 'sunpura',
      field7: 4,
      chargeSoc: 80,
      dischargeSoc: 10,
    });
    expect(other).toBe('1,00:00,23:59,-500,0,6,4,0,0,80,10');
  });

  it('keeps the literal 6 in field 5 even for aeg', () => {
    const aeg = encodeSlot({
      direction: 'discharge',
      powerW: 800,
      brand: 'aeg',
      field7: 4,
      chargeSoc: 100,
      dischargeSoc: 10,
    });
    expect(aeg.split(',')[5]).toBe('6');
  });
});

describe('decodeSlot', () => {
  it('returns null for the wrong field count', () => {
    expect(decodeSlot('1,00:00,23:59,-800')).toBeNull();
    expect(decodeSlot('')).toBeNull();
  });

  it('returns null for a non-numeric field 3', () => {
    expect(decodeSlot('1,00:00,23:59,abc,0,6,5,0,0,80,10')).toBeNull();
    expect(decodeSlot('1,00:00,23:59,,0,6,5,0,0,80,10')).toBeNull();
  });

  it('decodes a positive field 3 as discharge', () => {
    expect(decodeSlot('1,00:00,23:59,800,0,6,5,0,0,80,10')).toEqual({
      direction: 'discharge',
      powerW: 800,
    });
  });

  it('decodes a negative field 3 as charge with a positive magnitude', () => {
    expect(decodeSlot('1,00:00,23:59,-800,0,6,5,0,0,80,10')).toEqual({
      direction: 'charge',
      powerW: 800,
    });
  });

  it('decodes a zero field 3 as idle', () => {
    expect(decodeSlot('1,00:00,23:59,0,0,6,5,0,0,80,10')).toEqual({
      direction: 'idle',
      powerW: 0,
    });
  });

  it('decodes the canonical disabled slot as idle', () => {
    expect(decodeSlot('0,00:00,00:00,0,0,0,0,0,0,100,10')).toEqual({
      direction: 'idle',
      powerW: 0,
    });
  });

  // Register 3009 of the committed JET capture is exactly this shape: the
  // enable flag is off but field 3 still holds 1000. Reading that as a
  // setpoint would let a reapply or drift correction command it for real.
  it('ignores residual power in a disabled slot', () => {
    expect(decodeSlot('0,00:00,00:00,1000,500,0,0,0,0,100,10')).toEqual({
      direction: 'idle',
      powerW: 0,
    });
    expect(decodeSlot('0,00:00,00:00,-1000,0,6,5,0,0,80,10')).toEqual({
      direction: 'idle',
      powerW: 0,
    });
  });
});

describe('round trip', () => {
  const brands: BrandId[] = ['jet', 'aeg', 'lunergy', 'other'];
  const powers = [1, 100, 800, 2400];
  const directions: Direction[] = ['charge', 'discharge'];

  it.each(
    brands.flatMap(brand =>
      directions.flatMap(direction =>
        powers.map(powerW => ({ brand, direction, powerW }))
      )
    )
  )(
    'decodeSlot(encodeSlot($direction $powerW W on $brand)) recovers direction and magnitude',
    ({ brand, direction, powerW }) => {
      const slot = encodeSlot({
        direction,
        powerW,
        brand,
        field7: 5,
        chargeSoc: 90,
        dischargeSoc: 10,
      });
      expect(decodeSlot(slot)).toEqual({ direction, powerW });
    }
  );

  it('a zero-power request round-trips to idle regardless of requested direction', () => {
    for (const direction of ['charge', 'discharge'] as Direction[]) {
      const slot = encodeSlot({
        direction,
        powerW: 0,
        brand: 'jet',
        field7: 5,
        chargeSoc: 90,
        dischargeSoc: 10,
      });
      expect(decodeSlot(slot)).toEqual({ direction: 'idle', powerW: 0 });
    }
  });

  it('idle round-trips to idle', () => {
    const slot = encodeSlot({
      direction: 'idle',
      powerW: 0,
      brand: 'jet',
      field7: 5,
      chargeSoc: 90,
      dischargeSoc: 10,
    });
    expect(decodeSlot(slot)).toEqual({ direction: 'idle', powerW: 0 });
  });
});

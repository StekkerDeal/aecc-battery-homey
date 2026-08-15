import { describe, expect, it } from 'vitest';
import type { BrandId } from '../types';
import {
  BRAND_LABELS,
  BRAND_PROFILES,
  getBrandProfile,
  scheduleModeCustom,
  slotField6,
} from './brands';

describe('BRAND_PROFILES', () => {
  it('matches the confirmed thresholds for lunergy', () => {
    expect(BRAND_PROFILES.lunergy).toEqual({
      socZeroRejectDuringActiveW: 50,
      socMaxRatePctPerMin: 5.0,
      holdLastValueSeconds: 120,
    });
  });

  it.each<BrandId>([
    'sunpura',
    'voltdeer',
    'aeg',
    'aferiy',
    'accumate',
    'jet',
    'oscal',
  ])('matches the permissive thresholds for %s', brand => {
    expect(BRAND_PROFILES[brand]).toEqual({
      socZeroRejectDuringActiveW: 200,
      socMaxRatePctPerMin: 10.0,
      holdLastValueSeconds: 120,
    });
  });

  it('matches the conservative default thresholds for other', () => {
    expect(BRAND_PROFILES.other).toEqual({
      socZeroRejectDuringActiveW: 100,
      socMaxRatePctPerMin: 8.0,
      holdLastValueSeconds: 120,
    });
  });
});

describe('BRAND_LABELS', () => {
  it('has a display name for every brand', () => {
    expect(BRAND_LABELS).toEqual({
      lunergy: 'Lunergy',
      sunpura: 'Sunpura',
      voltdeer: 'Voltdeer',
      aeg: 'AEG',
      aferiy: 'AFERIY',
      accumate: 'AccuMate',
      jet: 'JET',
      oscal: 'Oscal',
      other: 'Other',
    });
  });
});

describe('getBrandProfile', () => {
  it('returns the matching profile for a known brand', () => {
    expect(getBrandProfile('jet')).toBe(BRAND_PROFILES.jet);
  });

  it('falls back to the other profile for an unknown brand', () => {
    expect(getBrandProfile('made-up' as BrandId)).toBe(BRAND_PROFILES.other);
  });
});

describe('scheduleModeCustom', () => {
  it('returns 3 for aeg', () => {
    expect(scheduleModeCustom('aeg')).toBe('3');
  });

  it.each<BrandId>(['lunergy', 'sunpura', 'jet', 'other'])(
    'returns 6 for %s',
    brand => {
      expect(scheduleModeCustom(brand)).toBe('6');
    }
  );
});

describe('slotField6', () => {
  it('returns 0 for aeg regardless of field7', () => {
    expect(slotField6('aeg', 5)).toBe(0);
    expect(slotField6('aeg', 4)).toBe(0);
  });

  it('returns field7 unchanged for other brands', () => {
    expect(slotField6('jet', 5)).toBe(5);
    expect(slotField6('jet', 4)).toBe(4);
  });
});

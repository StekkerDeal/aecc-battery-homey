import type { BrandId } from '../types';

export interface BrandProfile {
  socZeroRejectDuringActiveW: number;
  socMaxRatePctPerMin: number;
  holdLastValueSeconds: number;
}

// Lunergy is the flakiest SOC reporter (sustained SOC=0 during active
// discharge), so it gets the tightest thresholds. Brands without that
// pattern get a permissive profile that only catches impossible readings.
const LUNERGY: BrandProfile = {
  socZeroRejectDuringActiveW: 50,
  socMaxRatePctPerMin: 5.0,
  holdLastValueSeconds: 120,
};

const PERMISSIVE: BrandProfile = {
  socZeroRejectDuringActiveW: 200,
  socMaxRatePctPerMin: 10.0,
  holdLastValueSeconds: 120,
};

const OTHER: BrandProfile = {
  socZeroRejectDuringActiveW: 100,
  socMaxRatePctPerMin: 8.0,
  holdLastValueSeconds: 120,
};

export const BRAND_PROFILES: Record<BrandId, BrandProfile> = {
  lunergy: LUNERGY,
  sunpura: PERMISSIVE,
  voltdeer: PERMISSIVE,
  aeg: PERMISSIVE,
  aferiy: PERMISSIVE,
  accumate: PERMISSIVE,
  jet: PERMISSIVE,
  oscal: PERMISSIVE,
  other: OTHER,
};

export const BRAND_LABELS: Record<BrandId, string> = {
  lunergy: 'Lunergy',
  sunpura: 'Sunpura',
  voltdeer: 'Voltdeer',
  aeg: 'AEG',
  aferiy: 'AFERIY',
  accumate: 'AccuMate',
  jet: 'JET',
  oscal: 'Oscal',
  other: 'Other',
};

export function getBrandProfile(brand: BrandId): BrandProfile {
  return BRAND_PROFILES[brand] ?? BRAND_PROFILES.other;
}

// AEG mirrors its own app: Customized mode leaves 3020 at 3 instead of the
// custom-schedule value 6 every other brand uses.
export function scheduleModeCustom(brand: BrandId): string {
  return brand === 'aeg' ? '3' : '6';
}

// AEG wants field 6 of the control slot as 0; every other brand puts field7
// (the has-storage-list flag) there instead.
export function slotField6(brand: BrandId, field7: number): number {
  return brand === 'aeg' ? 0 : field7;
}

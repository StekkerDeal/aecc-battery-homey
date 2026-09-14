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
  fossibot: PERMISSIVE,
  tsun: PERMISSIVE,
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
  fossibot: 'Fossibot',
  tsun: 'TSUN',
  other: 'Other',
};

export function getBrandProfile(brand: BrandId): BrandProfile {
  return BRAND_PROFILES[brand] ?? BRAND_PROFILES.other;
}

// The highest power this app will ever command, per brand. Deliberately not
// part of BrandProfile, which is only about cleaning noisy sensor readings.
//
// 2400W is the platform default and the documented ceiling for register 3039
// (docs/protocol.md). Only a brand measured above it gets its own entry: the
// TSUN PowerTrunk MAU5000 is unlocked to 2500W and on 2026-09-14 reported
// 2621W of discharge while an independently wired HomeWizard meter read 2490W
// at the wall.
//
// This is the single source for the ceiling. It has to live in code because
// Homey declares a settings field's range and a flow card's argument range in
// the manifest, with no way to vary either per device, so both are declared at
// the widest brand's value and narrowed here instead.
export const DEFAULT_MAX_POWER_W = 2400;

const BRAND_MAX_POWER_W: Partial<Record<BrandId, number>> = {
  tsun: 2500,
};

export function getBrandMaxPowerW(brand: BrandId): number {
  return BRAND_MAX_POWER_W[brand] ?? DEFAULT_MAX_POWER_W;
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

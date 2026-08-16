import type { EnergyFrame, StorageUnit } from '../types';

export type TelemetryKey =
  | 'battery_soc'
  | 'ac_charging_power'
  | 'battery_discharging_power'
  | 'battery_charging_power'
  | 'pv_power'
  | 'pv_charging_power'
  | 'grid_power'
  | 'backup_power'
  | 'pv1_power'
  | 'pv2_power';

type AggMode = 'sum' | 'avg';

interface FieldSpec {
  summaryField: string | null;
  summaryScale: number;
  storageField: keyof StorageUnit;
  storageScale: number;
  agg: AggMode;
}

// Canonical key -> (summary field, summary scale, storage field, storage
// scale, aggregate). System values read the summary field when present,
// else aggregate Storage_list with the given scale. summaryField is null
// where no summary field is a straight sum of the units.
const FIELD_MAP: Record<TelemetryKey, FieldSpec> = {
  battery_soc: {
    summaryField: 'AverageBatteryAverageSOC',
    summaryScale: 1.0,
    storageField: 'BatterySoc',
    storageScale: 1.0,
    agg: 'avg',
  },
  ac_charging_power: {
    summaryField: 'TotalACChargePower',
    summaryScale: 1.0,
    storageField: 'AcChargingPower',
    storageScale: 0.1,
    agg: 'sum',
  },
  battery_discharging_power: {
    summaryField: 'TotalBatteryOutputPower',
    summaryScale: 1.0,
    storageField: 'BatteryDischargingPower',
    storageScale: 0.1,
    agg: 'sum',
  },
  // TotalChargePower is DC-side after losses, not the unit sum. Never read it.
  battery_charging_power: {
    summaryField: null,
    summaryScale: 1.0,
    storageField: 'BatteryChargingPower',
    storageScale: 0.1,
    agg: 'sum',
  },
  pv_power: {
    summaryField: 'TotalPVPower',
    summaryScale: 1.0,
    storageField: 'PvChargingPower',
    storageScale: 0.1,
    agg: 'sum',
  },
  pv_charging_power: {
    summaryField: 'TotalPVChargePower',
    summaryScale: 1.0,
    storageField: 'PvChargingPower',
    storageScale: 0.1,
    agg: 'sum',
  },
  // MeterTotalActivePower is the site CT meter, not a sum of the units.
  grid_power: {
    summaryField: 'MeterTotalActivePower',
    summaryScale: 1.0,
    storageField: 'AcInActivePower',
    storageScale: 0.1,
    agg: 'sum',
  },
  // Breaks both unit conventions: summary is 10W units, storage is watts
  // (not deciwatts like every other storage field).
  backup_power: {
    summaryField: 'TotalBackUpPower',
    summaryScale: 10.0,
    storageField: 'OffGridLoadPower',
    storageScale: 1.0,
    agg: 'sum',
  },
  pv1_power: {
    summaryField: null,
    summaryScale: 1.0,
    storageField: 'Pv1Power',
    storageScale: 1.0,
    agg: 'sum',
  },
  pv2_power: {
    summaryField: null,
    summaryScale: 1.0,
    storageField: 'Pv2Power',
    storageScale: 1.0,
    agg: 'sum',
  },
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function aggregateStorage(
  units: StorageUnit[],
  field: keyof StorageUnit,
  scale: number,
  mode: AggMode
): number | undefined {
  const values: number[] = [];
  for (const unit of units) {
    const num = toFiniteNumber(unit[field]);
    if (num === undefined) continue;
    values.push(num * scale);
  }
  if (values.length === 0) return undefined;
  const total = values.reduce((a, b) => a + b, 0);
  return round1(mode === 'avg' ? total / values.length : total);
}

// A frame with neither Storage_list nor SSumInfoList is invalid. Lunergy has
// no Storage_list at all, so every downstream path must work from
// SSumInfoList alone.
export function parseEnergyFrame(raw: unknown): EnergyFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const frame = raw as EnergyFrame;
  const hasStorage =
    Array.isArray(frame.Storage_list) && frame.Storage_list.length > 0;
  const hasSummary =
    !!frame.SSumInfoList && Object.keys(frame.SSumInfoList).length > 0;
  if (!hasStorage && !hasSummary) return null;
  return frame;
}

export function frameUnits(frame: EnergyFrame): StorageUnit[] {
  return frame.Storage_list ?? [];
}

// Stable unit identity: StorageSN, falling back to DevAddr. Never the list
// position, so a missing unit reads as absent instead of a neighbour's data.
export function unitKey(unit: StorageUnit): string {
  const sn = unit.StorageSN;
  if (sn) return String(sn).trim();
  return `addr${unit.DevAddr}`;
}

export function systemValue(
  frame: EnergyFrame,
  key: TelemetryKey
): number | undefined {
  const spec = FIELD_MAP[key];
  const summary = frame.SSumInfoList;
  if (spec.summaryField !== null && summary) {
    const num = toFiniteNumber(summary[spec.summaryField]);
    if (num !== undefined) return round1(num * spec.summaryScale);
  }
  return aggregateStorage(
    frameUnits(frame),
    spec.storageField,
    spec.storageScale,
    spec.agg
  );
}

export function unitValue(
  frame: EnergyFrame,
  targetUnitKey: string,
  key: TelemetryKey
): number | undefined {
  const spec = FIELD_MAP[key];
  for (const unit of frameUnits(frame)) {
    if (unitKey(unit) !== targetUnitKey) continue;
    const num = toFiniteNumber(unit[spec.storageField]);
    return num === undefined ? undefined : round1(num * spec.storageScale);
  }
  return undefined;
}

// Best-effort wall-side power magnitude used by the SOC cleaner. Signed:
// positive when charging, negative when discharging, null when neither
// source has data.
export function wallPowerSignalW(frame: EnergyFrame): number | null {
  const units = frameUnits(frame);
  for (const field of ['AcChargingPower', 'BatteryChargingPower'] as const) {
    const charge = aggregateStorage(units, field, 0.1, 'sum');
    if (charge !== undefined && charge > 0) return charge;
  }
  const discharge = aggregateStorage(
    units,
    'BatteryDischargingPower',
    0.1,
    'sum'
  );
  if (discharge !== undefined && discharge > 0) return -discharge;

  const summary = frame.SSumInfoList ?? {};
  const ac = summary.TotalACChargePower;
  const out = summary.TotalBatteryOutputPower;
  const acNum = toFiniteNumber(ac) ?? 0;
  const outNum = toFiniteNumber(out) ?? 0;
  if (acNum > 0) return acNum;
  if (outNum > 0) return -outNum;
  if (ac !== undefined || out !== undefined) return 0;
  return null;
}

// A stopped battery still draws standby power (10W measured on a JET), so an
// exact-zero test would never report idle. Only the tri-state label uses the
// deadband; measure_power itself stays truthful so the meters keep integrating.
export const IDLE_DEADBAND_W = 25;

// Absent readings stay null rather than collapsing to 0. The device surface
// varies per brand, so null means "this model does not report it" and drives
// which optional capabilities the device adds.
export interface DerivedTelemetry {
  measurePowerW: number | null;
  socPct: number | null;
  chargingState: 'charging' | 'discharging' | 'idle' | null;
  gridPowerW: number | null;
  gridExportW: number | null;
  pvPowerW: number | null;
  pv1PowerW: number | null;
  pv2PowerW: number | null;
  backupPowerW: number | null;
  unitCount: number;
  hasStorageList: boolean;
}

export function derive(
  frame: EnergyFrame,
  cleanedSoc: number | null
): DerivedTelemetry {
  const chargingPower = systemValue(frame, 'battery_charging_power');
  const acChargingPower = systemValue(frame, 'ac_charging_power');
  const dischargingPower = systemValue(frame, 'battery_discharging_power');
  const hasPowerSignal =
    chargingPower !== undefined ||
    acChargingPower !== undefined ||
    dischargingPower !== undefined;
  const measurePowerW = hasPowerSignal
    ? Math.max(chargingPower ?? 0, acChargingPower ?? 0) -
      (dischargingPower ?? 0)
    : null;
  const chargingState =
    measurePowerW === null
      ? null
      : measurePowerW > IDLE_DEADBAND_W
        ? 'charging'
        : measurePowerW < -IDLE_DEADBAND_W
          ? 'discharging'
          : 'idle';

  const gridPowerW = systemValue(frame, 'grid_power') ?? null;
  const units = frameUnits(frame);

  return {
    measurePowerW,
    socPct: cleanedSoc,
    chargingState,
    gridPowerW,
    gridExportW: gridPowerW === null ? null : Math.max(0, -gridPowerW),
    pvPowerW: systemValue(frame, 'pv_power') ?? null,
    pv1PowerW: systemValue(frame, 'pv1_power') ?? null,
    pv2PowerW: systemValue(frame, 'pv2_power') ?? null,
    backupPowerW: systemValue(frame, 'backup_power') ?? null,
    unitCount: units.length,
    hasStorageList: units.length > 0,
  };
}

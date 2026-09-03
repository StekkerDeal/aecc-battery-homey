export type BrandId =
  | 'lunergy'
  | 'sunpura'
  | 'voltdeer'
  | 'aeg'
  | 'aferiy'
  | 'accumate'
  | 'jet'
  | 'oscal'
  | 'fossibot'
  | 'other';

export type Direction = 'charge' | 'discharge' | 'idle';

export interface StorageUnit {
  DevAddr?: number;
  StorageSN?: string;
  StorageStatus?: number;
  BatterySoc?: number;
  AcChargingPower?: number;
  PvChargingPower?: number;
  BatteryChargingPower?: number;
  BatteryDischargingPower?: number;
  AcInActivePower?: number;
  OffGridLoadPower?: number;
  PvStringCount?: number;
  Pv1Power?: number;
  Pv2Power?: number;
}

export interface EnergyFrame {
  Storage_list?: StorageUnit[];
  SSumInfoList?: Record<string, number | string>;
}

export interface DeviceIdentity {
  serial?: string;
  firmware?: string;
  model?: string;
  rssi?: number;
}

import { MAX_REGISTER_POWER_DEFAULT } from '../protocol/registers';
import type { BrandId } from '../types';

export interface AeccDeviceSettings {
  host: string;
  port: number;
  pollIntervalS: number;
  brand: BrandId;
  maxChargePowerW: number;
  maxDischargePowerW: number;
  verifyIntervalS: number;
}

export type RawSettings = {
  [key: string]: boolean | string | number | undefined | null;
};

const DEFAULT_POLL_INTERVAL_S = 5;
const DEFAULT_VERIFY_INTERVAL_S = 60;

/**
 * Maps the raw driver.settings.compose.json keys to AeccDeviceSettings,
 * applying the same defaults as the settings page.
 */
export function settingsFrom(raw: RawSettings): AeccDeviceSettings {
  return {
    host: String(raw.host ?? ''),
    port: Number(raw.port ?? 0),
    pollIntervalS: Number(raw.poll_interval ?? DEFAULT_POLL_INTERVAL_S),
    brand: (raw.brand as BrandId | undefined) ?? 'other',
    maxChargePowerW: Number(raw.max_charge_power ?? MAX_REGISTER_POWER_DEFAULT),
    maxDischargePowerW: Number(
      raw.max_discharge_power ?? MAX_REGISTER_POWER_DEFAULT
    ),
    verifyIntervalS: Number(raw.verify_interval ?? DEFAULT_VERIFY_INTERVAL_S),
  };
}

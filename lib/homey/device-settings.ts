import { getBrandMaxPowerW } from '../protocol/brands';
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
 *
 * The two power limits are additionally capped at the brand's ceiling. The
 * settings page offers the widest brand's range to everyone, because Homey
 * declares a settings field's range in the manifest with no way to vary it per
 * device, so the narrowing has to happen here. This is the only place it needs
 * to: the session's limits and the target_power slider's range are both built
 * from this result.
 */
export function settingsFrom(raw: RawSettings): AeccDeviceSettings {
  const brand = (raw.brand as BrandId | undefined) ?? 'other';
  const ceilingW = getBrandMaxPowerW(brand);
  return {
    host: String(raw.host ?? ''),
    port: Number(raw.port ?? 0),
    pollIntervalS: Number(raw.poll_interval ?? DEFAULT_POLL_INTERVAL_S),
    brand,
    maxChargePowerW: Math.min(
      Number(raw.max_charge_power ?? MAX_REGISTER_POWER_DEFAULT),
      ceilingW
    ),
    maxDischargePowerW: Math.min(
      Number(raw.max_discharge_power ?? MAX_REGISTER_POWER_DEFAULT),
      ceilingW
    ),
    verifyIntervalS: Number(raw.verify_interval ?? DEFAULT_VERIFY_INTERVAL_S),
  };
}

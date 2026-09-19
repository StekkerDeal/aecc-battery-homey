import type { SessionSnapshot } from '../session';
import type {
  EnergyIntegrator,
  ProductionIntegrator,
} from '../protocol/energy-meter';
import type { DerivedTelemetry } from '../protocol/telemetry';
import type { DeviceIdentity } from '../types';

export interface CapabilityUpdate {
  id: string;
  value: number | string | boolean | null;
}

// kWh meter capabilities: round to Wh precision so repeated small samples
// do not leave visible floating point noise in the Homey UI.
function roundKwh(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Maps one session snapshot plus the running energy meter to the full set
 * of Homey capability updates. Mandatory capabilities are always present
 * (with a null value when the reading is unavailable); the per-brand
 * optional sub-capabilities are only pushed when their source value is
 * non-null, mirroring optionalCapabilities().
 */
export function mapSnapshot(
  snapshot: SessionSnapshot,
  meter: EnergyIntegrator
): CapabilityUpdate[] {
  const telemetry = snapshot.telemetry;

  const updates: CapabilityUpdate[] = [
    { id: 'measure_power', value: telemetry?.measurePowerW ?? null },
    { id: 'measure_battery', value: telemetry?.socPct ?? null },
    { id: 'battery_charging_state', value: telemetry?.chargingState ?? null },
    { id: 'meter_power.charged', value: roundKwh(meter.chargedKwh) },
    { id: 'meter_power.discharged', value: roundKwh(meter.dischargedKwh) },
    { id: 'aecc_min_soc', value: snapshot.minSoc },
    { id: 'aecc_max_soc', value: snapshot.maxSoc },
    {
      id: 'aecc_last_update',
      value:
        snapshot.lastGoodPollAtMs === null
          ? null
          : new Date(snapshot.lastGoodPollAtMs).toISOString(),
    },
  ];

  if (telemetry) {
    if (telemetry.gridPowerW !== null) {
      updates.push({ id: 'measure_power.grid', value: telemetry.gridPowerW });
    }
    // PV is not reported here any more: it lives on the solar device from
    // 1.2.0, which is a solarpanel-class device and so is the only place it
    // can reach the Homey Energy tab as production.
    if (telemetry.backupPowerW !== null) {
      updates.push({
        id: 'measure_power.backup',
        value: telemetry.backupPowerW,
      });
    }
  }

  if (snapshot.identity?.rssi !== undefined) {
    updates.push({
      id: 'aecc_signal_strength',
      value: snapshot.identity.rssi,
    });
  }

  return updates;
}

/**
 * Maps one session snapshot plus the PV meter to the solar device's
 * capabilities. Three values, always present, no runtime sub-capabilities:
 * per-string readings are deliberately absent until a capture from a
 * generating system settles what the PvXPower fields actually mean.
 *
 * measure_power is null rather than 0 when there is no reading, so a model
 * that does not report PV at all reads as unknown instead of as darkness.
 */
export function mapPvSnapshot(
  snapshot: SessionSnapshot,
  meter: ProductionIntegrator
): CapabilityUpdate[] {
  return [
    { id: 'measure_power', value: snapshot.telemetry?.pvTotalPowerW ?? null },
    { id: 'meter_power', value: roundKwh(meter.generatedKwh) },
    {
      id: 'aecc_last_update',
      value:
        snapshot.lastGoodPollAtMs === null
          ? null
          : new Date(snapshot.lastGoodPollAtMs).toISOString(),
    },
  ];
}

/**
 * Sub-capability ids that should exist for this device, derived from which
 * readings the brand actually reports. Absent (null/undefined) source
 * values mean the model does not expose that reading, not that it is zero.
 */
export function optionalCapabilities(
  derived: DerivedTelemetry,
  identity: DeviceIdentity
): string[] {
  const ids: string[] = [];
  if (derived.gridPowerW !== null) ids.push('measure_power.grid');
  if (derived.backupPowerW !== null) ids.push('measure_power.backup');
  if (identity.rssi !== undefined) ids.push('aecc_signal_strength');
  return ids;
}

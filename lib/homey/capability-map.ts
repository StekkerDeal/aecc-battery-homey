import type { SessionSnapshot } from '../session';
import type { EnergyIntegrator } from '../protocol/energy-meter';
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
    if (telemetry.pvPowerW !== null) {
      updates.push({ id: 'measure_power.pv', value: telemetry.pvPowerW });
    }
    if (telemetry.pv1PowerW !== null) {
      updates.push({ id: 'measure_power.pv1', value: telemetry.pv1PowerW });
    }
    if (telemetry.pv2PowerW !== null) {
      updates.push({ id: 'measure_power.pv2', value: telemetry.pv2PowerW });
    }
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
  if (derived.pvPowerW !== null) ids.push('measure_power.pv');
  if (derived.pv1PowerW !== null) ids.push('measure_power.pv1');
  if (derived.pv2PowerW !== null) ids.push('measure_power.pv2');
  if (derived.backupPowerW !== null) ids.push('measure_power.backup');
  if (identity.rssi !== undefined) ids.push('aecc_signal_strength');
  return ids;
}

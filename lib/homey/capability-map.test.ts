import { describe, expect, it } from 'vitest';
import {
  mapPvSnapshot,
  mapSnapshot,
  optionalCapabilities,
} from './capability-map';
import {
  EnergyIntegrator,
  ProductionIntegrator,
} from '../protocol/energy-meter';
import type { DerivedTelemetry } from '../protocol/telemetry';
import type { SessionSnapshot } from '../session';
import type { DeviceIdentity } from '../types';

function makeTelemetry(
  overrides: Partial<DerivedTelemetry> = {}
): DerivedTelemetry {
  return {
    measurePowerW: 500,
    socPct: 62,
    chargingState: 'charging',
    gridPowerW: null,
    gridExportW: null,
    pvPowerW: null,
    pvTotalPowerW: null,
    pv1PowerW: null,
    pv2PowerW: null,
    backupPowerW: null,
    unitCount: 1,
    hasStorageList: true,
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<SessionSnapshot> = {}
): SessionSnapshot {
  return {
    brand: 'jet',
    telemetry: makeTelemetry(),
    identity: null,
    workMode: 'custom',
    commandedTargetPowerW: 500,
    minSoc: 10,
    maxSoc: 90,
    hasStorageList: true,
    available: true,
    consecutiveFailedPolls: 0,
    lastPollAtMs: 1_000,
    lastGoodPollAtMs: 1_000,
    frameGuard: { suspectFramesTotal: 0, lastReason: null, lastAt: null },
    ...overrides,
  };
}

function updateFor(updates: { id: string; value: unknown }[], id: string) {
  return updates.find(u => u.id === id);
}

describe('mapSnapshot', () => {
  it('maps the mandatory capabilities from a fully populated snapshot', () => {
    const meter = new EnergyIntegrator({
      chargedKwh: 1.5,
      dischargedKwh: 0.25,
    });
    const snapshot = makeSnapshot();

    const updates = mapSnapshot(snapshot, meter);

    expect(updateFor(updates, 'measure_power')).toEqual({
      id: 'measure_power',
      value: 500,
    });
    expect(updateFor(updates, 'measure_battery')).toEqual({
      id: 'measure_battery',
      value: 62,
    });
    expect(updateFor(updates, 'battery_charging_state')).toEqual({
      id: 'battery_charging_state',
      value: 'charging',
    });
    expect(updateFor(updates, 'meter_power.charged')).toEqual({
      id: 'meter_power.charged',
      value: 1.5,
    });
    expect(updateFor(updates, 'meter_power.discharged')).toEqual({
      id: 'meter_power.discharged',
      value: 0.25,
    });
    expect(updateFor(updates, 'aecc_min_soc')).toEqual({
      id: 'aecc_min_soc',
      value: 10,
    });
    expect(updateFor(updates, 'aecc_max_soc')).toEqual({
      id: 'aecc_max_soc',
      value: 90,
    });
    expect(updateFor(updates, 'aecc_last_update')).toEqual({
      id: 'aecc_last_update',
      value: new Date(1_000).toISOString(),
    });
  });

  it('rounds the meter counters to Wh precision', () => {
    const meter = new EnergyIntegrator({
      chargedKwh: 1.234_567_89,
      dischargedKwh: 0.000_049,
    });
    const updates = mapSnapshot(makeSnapshot(), meter);

    expect(updateFor(updates, 'meter_power.charged')?.value).toBe(1.235);
    expect(updateFor(updates, 'meter_power.discharged')?.value).toBe(0);
  });

  it('reports null for the mandatory readings when telemetry is absent', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({ telemetry: null });

    const updates = mapSnapshot(snapshot, meter);

    expect(updateFor(updates, 'measure_power')?.value).toBeNull();
    expect(updateFor(updates, 'measure_battery')?.value).toBeNull();
    expect(updateFor(updates, 'battery_charging_state')?.value).toBeNull();
    // Optional sub-capabilities never appear when there is no telemetry at all.
    expect(updateFor(updates, 'measure_power.grid')).toBeUndefined();
  });

  it('reports null aecc_last_update when there has never been a good poll', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({ lastGoodPollAtMs: null });

    const updates = mapSnapshot(snapshot, meter);

    expect(updateFor(updates, 'aecc_last_update')?.value).toBeNull();
  });

  it('a Lunergy-shaped snapshot (no grid/pv/backup/rssi) yields no optional capability updates', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({
        gridPowerW: null,
        pvPowerW: null,
        pv1PowerW: null,
        pv2PowerW: null,
        backupPowerW: null,
      }),
      identity: { serial: 'LUN1', firmware: '1.0' },
    });

    const updates = mapSnapshot(snapshot, meter);

    for (const id of [
      'measure_power.grid',
      'measure_power.pv',
      'measure_power.pv1',
      'measure_power.pv2',
      'measure_power.backup',
      'aecc_signal_strength',
    ]) {
      expect(updateFor(updates, id)).toBeUndefined();
    }
  });

  it('a PV-bearing snapshot yields the PV, grid, backup and signal entries', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({
        gridPowerW: -120,
        pvPowerW: 1800,
        pvTotalPowerW: 1800,
        pv1PowerW: 900,
        pv2PowerW: 900,
        backupPowerW: 0,
      }),
      identity: { serial: 'JET1', rssi: -55 },
    });

    const updates = mapSnapshot(snapshot, meter);

    expect(updateFor(updates, 'measure_power.grid')).toEqual({
      id: 'measure_power.grid',
      value: -120,
    });
    expect(updateFor(updates, 'measure_power.pv')).toEqual({
      id: 'measure_power.pv',
      value: 1800,
    });
    expect(updateFor(updates, 'measure_power.pv1')).toEqual({
      id: 'measure_power.pv1',
      value: 900,
    });
    expect(updateFor(updates, 'measure_power.pv2')).toEqual({
      id: 'measure_power.pv2',
      value: 900,
    });
    // 0 is a real reading, not an absent one, so it must still be reported.
    expect(updateFor(updates, 'measure_power.backup')).toEqual({
      id: 'measure_power.backup',
      value: 0,
    });
    expect(updateFor(updates, 'aecc_signal_strength')).toEqual({
      id: 'aecc_signal_strength',
      value: -55,
    });
  });

  it('reports aecc_signal_strength when rssi is 0 (falsy but present)', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({ identity: { serial: 'X', rssi: 0 } });

    const updates = mapSnapshot(snapshot, meter);

    expect(updateFor(updates, 'aecc_signal_strength')).toEqual({
      id: 'aecc_signal_strength',
      value: 0,
    });
  });

  it('omits aecc_signal_strength when identity is null or rssi is undefined', () => {
    const meter = new EnergyIntegrator();
    expect(
      updateFor(
        mapSnapshot(makeSnapshot({ identity: null }), meter),
        'aecc_signal_strength'
      )
    ).toBeUndefined();
    expect(
      updateFor(
        mapSnapshot(makeSnapshot({ identity: { serial: 'X' } }), meter),
        'aecc_signal_strength'
      )
    ).toBeUndefined();
  });
});

describe('optionalCapabilities', () => {
  const noIdentity: DeviceIdentity = {};

  it('a Lunergy-shaped device (no optional readings, no rssi) needs no optional capabilities', () => {
    const ids = optionalCapabilities(makeTelemetry(), noIdentity);
    expect(ids).toEqual([]);
  });

  it('a PV-bearing device needs the PV, grid and backup capabilities', () => {
    const ids = optionalCapabilities(
      makeTelemetry({
        gridPowerW: 100,
        pvPowerW: 1800,
        pvTotalPowerW: 1800,
        pv1PowerW: 900,
        pv2PowerW: 900,
        backupPowerW: 0,
      }),
      noIdentity
    );
    expect(ids).toEqual([
      'measure_power.grid',
      'measure_power.pv',
      'measure_power.pv1',
      'measure_power.pv2',
      'measure_power.backup',
    ]);
  });

  it('adds aecc_signal_strength only when identity.rssi is defined, including 0', () => {
    expect(optionalCapabilities(makeTelemetry(), { rssi: 0 })).toEqual([
      'aecc_signal_strength',
    ]);
    expect(optionalCapabilities(makeTelemetry(), {})).toEqual([]);
  });

  it('supports a single PV string with no PV1/PV2 split', () => {
    const ids = optionalCapabilities(
      makeTelemetry({ pvPowerW: 1200, pv1PowerW: null, pv2PowerW: null }),
      noIdentity
    );
    expect(ids).toEqual(['measure_power.pv']);
  });

  it('supports a split PV1/PV2 device with no combined pv total', () => {
    const ids = optionalCapabilities(
      makeTelemetry({ pvPowerW: null, pv1PowerW: 600, pv2PowerW: 600 }),
      noIdentity
    );
    expect(ids).toEqual(['measure_power.pv1', 'measure_power.pv2']);
  });
});

describe('mapPvSnapshot', () => {
  it('maps the mandatory capabilities from a fully populated snapshot', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 2.5 });
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({ pvTotalPowerW: 758 }),
    });

    const updates = mapPvSnapshot(snapshot, meter);

    expect(updateFor(updates, 'measure_power')).toEqual({
      id: 'measure_power',
      value: 758,
    });
    expect(updateFor(updates, 'meter_power')).toEqual({
      id: 'meter_power',
      value: 2.5,
    });
    expect(updateFor(updates, 'aecc_last_update')).toEqual({
      id: 'aecc_last_update',
      value: new Date(1_000).toISOString(),
    });
  });

  it('reports measure_power null when telemetry is absent, but still emits meter_power', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 3.2 });
    const snapshot = makeSnapshot({ telemetry: null });

    const updates = mapPvSnapshot(snapshot, meter);

    // Null rather than 0 is the point: no reading is not the same as no sun.
    expect(updateFor(updates, 'measure_power')?.value).toBeNull();
    expect(updateFor(updates, 'meter_power')).toEqual({
      id: 'meter_power',
      value: 3.2,
    });
  });

  it('reports measure_power null when live telemetry has no PV total', () => {
    const meter = new ProductionIntegrator();
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({ pvTotalPowerW: null }),
    });

    const updates = mapPvSnapshot(snapshot, meter);

    expect(updateFor(updates, 'measure_power')?.value).toBeNull();
  });

  it('reports a real 0 reading as 0, not null', () => {
    const meter = new ProductionIntegrator();
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({ pvTotalPowerW: 0 }),
    });

    const updates = mapPvSnapshot(snapshot, meter);

    expect(updateFor(updates, 'measure_power')?.value).toBe(0);
  });

  it('reports null aecc_last_update when there has never been a good poll', () => {
    const meter = new ProductionIntegrator();
    const snapshot = makeSnapshot({ lastGoodPollAtMs: null });

    const updates = mapPvSnapshot(snapshot, meter);

    expect(updateFor(updates, 'aecc_last_update')?.value).toBeNull();
  });

  it('rounds meter_power to Wh precision, matching mapSnapshot', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 1.234_567_89 });
    const updates = mapPvSnapshot(makeSnapshot(), meter);

    expect(updateFor(updates, 'meter_power')?.value).toBe(1.235);
  });

  it('returns exactly the three PV capability ids, no battery or per-string PV leakage', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 1 });
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({
        pvTotalPowerW: 758,
        pvPowerW: 1800,
        pv1PowerW: 900,
        pv2PowerW: 900,
        gridPowerW: -120,
        backupPowerW: 0,
      }),
      identity: { serial: 'JET1', rssi: -55 },
    });

    const updates = mapPvSnapshot(snapshot, meter);

    expect(updates.map(u => u.id)).toEqual([
      'measure_power',
      'meter_power',
      'aecc_last_update',
    ]);
  });

  it('never emits a measure_power.pv* id under any input', () => {
    const meter = new ProductionIntegrator();
    const inputs: SessionSnapshot[] = [
      makeSnapshot(),
      makeSnapshot({ telemetry: null }),
      makeSnapshot({ telemetry: makeTelemetry({ pvTotalPowerW: null }) }),
      makeSnapshot({ telemetry: makeTelemetry({ pvTotalPowerW: 0 }) }),
      makeSnapshot({
        telemetry: makeTelemetry({
          pvTotalPowerW: 758,
          pvPowerW: 1800,
          pv1PowerW: 900,
          pv2PowerW: 900,
        }),
      }),
    ];

    for (const snapshot of inputs) {
      const ids = mapPvSnapshot(snapshot, meter).map(u => u.id);
      expect(ids.some(id => id.startsWith('measure_power.pv'))).toBe(false);
    }
  });
});

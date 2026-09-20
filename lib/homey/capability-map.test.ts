import { describe, expect, it } from 'vitest';
import {
  mapPvSnapshot,
  mapSnapshot,
  optionalCapabilities,
  pvOptionalCapabilities,
} from './capability-map';
import {
  EnergyIntegrator,
  ProductionIntegrator,
} from '../protocol/energy-meter';
import type { DerivedTelemetry } from '../protocol/telemetry';
import type { SessionSnapshot } from '../session';
import type { DeviceIdentity } from '../types';

const DEFAULT_TZ = 'Europe/Amsterdam';

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

    const updates = mapSnapshot(snapshot, meter, DEFAULT_TZ);

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
      // 1_000ms is 1970-01-01T00:00:01Z. The Netherlands was UTC+1 with no
      // DST in January 1970, so Europe/Amsterdam reads one hour ahead.
      value: '1970-01-01 01:00:01',
    });
  });

  it('rounds the meter counters to Wh precision', () => {
    const meter = new EnergyIntegrator({
      chargedKwh: 1.234_567_89,
      dischargedKwh: 0.000_049,
    });
    const updates = mapSnapshot(makeSnapshot(), meter, DEFAULT_TZ);

    expect(updateFor(updates, 'meter_power.charged')?.value).toBe(1.235);
    expect(updateFor(updates, 'meter_power.discharged')?.value).toBe(0);
  });

  it('reports null for the mandatory readings when telemetry is absent', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({ telemetry: null });

    const updates = mapSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'measure_power')?.value).toBeNull();
    expect(updateFor(updates, 'measure_battery')?.value).toBeNull();
    expect(updateFor(updates, 'battery_charging_state')?.value).toBeNull();
    // Optional sub-capabilities never appear when there is no telemetry at all.
    expect(updateFor(updates, 'measure_power.grid')).toBeUndefined();
  });

  it('reports null aecc_last_update when there has never been a good poll', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({ lastGoodPollAtMs: null });

    const updates = mapSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'aecc_last_update')?.value).toBeNull();
  });

  it('renders the same instant differently in two zones, proving the timezone argument is used', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({ lastGoodPollAtMs: 1_000 });

    const amsterdam = mapSnapshot(snapshot, meter, 'Europe/Amsterdam');
    const utc = mapSnapshot(snapshot, meter, 'UTC');

    expect(updateFor(amsterdam, 'aecc_last_update')?.value).toBe(
      '1970-01-01 01:00:01'
    );
    expect(updateFor(utc, 'aecc_last_update')?.value).toBe(
      '1970-01-01 00:00:01'
    );
  });

  it('reports null aecc_last_update, not the epoch, in every zone when there has never been a good poll', () => {
    const meter = new EnergyIntegrator();
    const snapshot = makeSnapshot({ lastGoodPollAtMs: null });

    for (const timeZone of ['Europe/Amsterdam', 'UTC']) {
      const updates = mapSnapshot(snapshot, meter, timeZone);
      expect(updateFor(updates, 'aecc_last_update')?.value).toBeNull();
    }
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

    const updates = mapSnapshot(snapshot, meter, DEFAULT_TZ);

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

  it('a PV-bearing snapshot yields the grid, backup and signal entries, and no PV', () => {
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

    const updates = mapSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'measure_power.grid')).toEqual({
      id: 'measure_power.grid',
      value: -120,
    });
    // PV moved to the solar device in 1.2.0. Even a battery reporting a
    // healthy 1800W of PV must not surface it here, because a
    // battery-class device cannot reach the Energy tab as production.
    expect(
      updates.some(update => update.id.startsWith('measure_power.pv'))
    ).toBe(false);
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

    const updates = mapSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'aecc_signal_strength')).toEqual({
      id: 'aecc_signal_strength',
      value: 0,
    });
  });

  it('omits aecc_signal_strength when identity is null or rssi is undefined', () => {
    const meter = new EnergyIntegrator();
    expect(
      updateFor(
        mapSnapshot(makeSnapshot({ identity: null }), meter, DEFAULT_TZ),
        'aecc_signal_strength'
      )
    ).toBeUndefined();
    expect(
      updateFor(
        mapSnapshot(
          makeSnapshot({ identity: { serial: 'X' } }),
          meter,
          DEFAULT_TZ
        ),
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

  it('a PV-bearing device needs the grid and backup capabilities, but no PV ones', () => {
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
    expect(ids).toEqual(['measure_power.grid', 'measure_power.backup']);
  });

  it('adds aecc_signal_strength only when identity.rssi is defined, including 0', () => {
    expect(optionalCapabilities(makeTelemetry(), { rssi: 0 })).toEqual([
      'aecc_signal_strength',
    ]);
    expect(optionalCapabilities(makeTelemetry(), {})).toEqual([]);
  });

  // The battery device no longer adds a PV capability under any shape of
  // PV telemetry: a single combined total, a per-string split, or both.
  // Whatever the model reports, PV belongs to the solar device now.
  it('never asks for a PV capability, whatever PV the model reports', () => {
    const shapes = [
      makeTelemetry({ pvPowerW: 1200, pvTotalPowerW: 1200 }),
      makeTelemetry({ pv1PowerW: 600, pv2PowerW: 600 }),
      makeTelemetry({
        pvPowerW: 1200,
        pvTotalPowerW: 1200,
        pv1PowerW: 600,
        pv2PowerW: 600,
      }),
    ];
    for (const telemetry of shapes) {
      expect(optionalCapabilities(telemetry, noIdentity)).toEqual([]);
    }
  });
});

describe('mapPvSnapshot', () => {
  it('maps the mandatory capabilities from a fully populated snapshot', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 2.5 });
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({ pvTotalPowerW: 758 }),
    });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

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
      // Same instant, same reasoning as mapSnapshot's equivalent assertion:
      // 1970-01-01T00:00:01Z was 01:00:01 in Europe/Amsterdam (UTC+1, no
      // DST yet in January 1970).
      value: '1970-01-01 01:00:01',
    });
  });

  it('reports measure_power null when telemetry is absent, but still emits meter_power', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 3.2 });
    const snapshot = makeSnapshot({ telemetry: null });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

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

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'measure_power')?.value).toBeNull();
  });

  it('reports a real 0 reading as 0, not null', () => {
    const meter = new ProductionIntegrator();
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({ pvTotalPowerW: 0 }),
    });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'measure_power')?.value).toBe(0);
  });

  it('reports null aecc_last_update when there has never been a good poll', () => {
    const meter = new ProductionIntegrator();
    const snapshot = makeSnapshot({ lastGoodPollAtMs: null });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'aecc_last_update')?.value).toBeNull();
  });

  it('renders the same instant differently in two zones, proving the timezone argument is used', () => {
    const meter = new ProductionIntegrator();
    const snapshot = makeSnapshot({ lastGoodPollAtMs: 1_000 });

    const amsterdam = mapPvSnapshot(snapshot, meter, 'Europe/Amsterdam');
    const utc = mapPvSnapshot(snapshot, meter, 'UTC');

    expect(updateFor(amsterdam, 'aecc_last_update')?.value).toBe(
      '1970-01-01 01:00:01'
    );
    expect(updateFor(utc, 'aecc_last_update')?.value).toBe(
      '1970-01-01 00:00:01'
    );
  });

  it('rounds meter_power to Wh precision, matching mapSnapshot', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 1.234_567_89 });
    const updates = mapPvSnapshot(makeSnapshot(), meter, DEFAULT_TZ);

    expect(updateFor(updates, 'meter_power')?.value).toBe(1.235);
  });

  it('emits both per-string ids, with their values, when both strings report', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 1 });
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({ pv1PowerW: 900, pv2PowerW: 850 }),
    });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'measure_power.pv1')).toEqual({
      id: 'measure_power.pv1',
      value: 900,
    });
    expect(updateFor(updates, 'measure_power.pv2')).toEqual({
      id: 'measure_power.pv2',
      value: 850,
    });
  });

  it('emits a real 0 per-string reading as 0, not omitted, matching every device captured so far', () => {
    const meter = new ProductionIntegrator();
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({ pv1PowerW: 0, pv2PowerW: 0 }),
    });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'measure_power.pv1')).toEqual({
      id: 'measure_power.pv1',
      value: 0,
    });
    expect(updateFor(updates, 'measure_power.pv2')).toEqual({
      id: 'measure_power.pv2',
      value: 0,
    });
  });

  it('emits only the string that is non-null, in either direction', () => {
    const meter = new ProductionIntegrator();

    const pv1Only = mapPvSnapshot(
      makeSnapshot({
        telemetry: makeTelemetry({ pv1PowerW: 900, pv2PowerW: null }),
      }),
      meter,
      DEFAULT_TZ
    );
    expect(updateFor(pv1Only, 'measure_power.pv1')).toEqual({
      id: 'measure_power.pv1',
      value: 900,
    });
    expect(updateFor(pv1Only, 'measure_power.pv2')).toBeUndefined();

    const pv2Only = mapPvSnapshot(
      makeSnapshot({
        telemetry: makeTelemetry({ pv1PowerW: null, pv2PowerW: 850 }),
      }),
      meter,
      DEFAULT_TZ
    );
    expect(updateFor(pv2Only, 'measure_power.pv2')).toEqual({
      id: 'measure_power.pv2',
      value: 850,
    });
    expect(updateFor(pv2Only, 'measure_power.pv1')).toBeUndefined();
  });

  it('emits neither per-string id when both are null', () => {
    const meter = new ProductionIntegrator();
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({ pv1PowerW: null, pv2PowerW: null }),
    });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'measure_power.pv1')).toBeUndefined();
    expect(updateFor(updates, 'measure_power.pv2')).toBeUndefined();
  });

  it('emits neither per-string id when telemetry is absent, but still emits the three base values', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 3.2 });
    const snapshot = makeSnapshot({ telemetry: null });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updateFor(updates, 'measure_power.pv1')).toBeUndefined();
    expect(updateFor(updates, 'measure_power.pv2')).toBeUndefined();
    expect(updateFor(updates, 'measure_power')?.value).toBeNull();
    expect(updateFor(updates, 'meter_power')).toEqual({
      id: 'meter_power',
      value: 3.2,
    });
    expect(updateFor(updates, 'aecc_last_update')).toEqual({
      id: 'aecc_last_update',
      value: '1970-01-01 01:00:01',
    });
  });

  it('returns exactly the five expected ids when both strings are present', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 1 });
    const snapshot = makeSnapshot({
      telemetry: makeTelemetry({
        pvTotalPowerW: 758,
        pv1PowerW: 900,
        pv2PowerW: 850,
      }),
    });

    const updates = mapPvSnapshot(snapshot, meter, DEFAULT_TZ);

    expect(updates.map(u => u.id)).toEqual([
      'measure_power',
      'meter_power',
      'aecc_last_update',
      'measure_power.pv1',
      'measure_power.pv2',
    ]);
  });

  it('never emits a battery capability, whatever the input, since this is the solar device', () => {
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
          gridPowerW: -120,
          backupPowerW: 0,
        }),
        identity: { serial: 'JET1', rssi: -55 },
      }),
    ];

    for (const snapshot of inputs) {
      const ids = mapPvSnapshot(snapshot, meter, DEFAULT_TZ).map(u => u.id);
      for (const bannedId of [
        'measure_battery',
        'target_power',
        'measure_power.grid',
        'measure_power.backup',
        'aecc_signal_strength',
      ]) {
        expect(ids).not.toContain(bannedId);
      }
    }
  });

  it('never emits measure_power.pv3 or .pv4, since pv3/pv4 are still unmapped', () => {
    const meter = new ProductionIntegrator();
    const inputs: SessionSnapshot[] = [
      makeSnapshot(),
      makeSnapshot({ telemetry: null }),
      makeSnapshot({
        telemetry: makeTelemetry({ pv1PowerW: 900, pv2PowerW: 850 }),
      }),
    ];

    for (const snapshot of inputs) {
      const ids = mapPvSnapshot(snapshot, meter, DEFAULT_TZ).map(u => u.id);
      expect(ids).not.toContain('measure_power.pv3');
      expect(ids).not.toContain('measure_power.pv4');
    }
  });
});

describe('pvOptionalCapabilities', () => {
  it('returns both ids when both fields are non-null', () => {
    const ids = pvOptionalCapabilities(
      makeTelemetry({ pv1PowerW: 900, pv2PowerW: 850 })
    );
    expect(ids).toEqual(['measure_power.pv1', 'measure_power.pv2']);
  });

  it('returns one id when only one field is non-null, in either direction', () => {
    expect(
      pvOptionalCapabilities(makeTelemetry({ pv1PowerW: 900, pv2PowerW: null }))
    ).toEqual(['measure_power.pv1']);
    expect(
      pvOptionalCapabilities(makeTelemetry({ pv1PowerW: null, pv2PowerW: 850 }))
    ).toEqual(['measure_power.pv2']);
  });

  it('returns an empty array when neither field is non-null', () => {
    const ids = pvOptionalCapabilities(
      makeTelemetry({ pv1PowerW: null, pv2PowerW: null })
    );
    expect(ids).toEqual([]);
  });

  it('still returns the id when the value is a real 0', () => {
    const ids = pvOptionalCapabilities(
      makeTelemetry({ pv1PowerW: 0, pv2PowerW: 0 })
    );
    expect(ids).toEqual(['measure_power.pv1', 'measure_power.pv2']);
  });

  it('never returns the old battery layout total measure_power.pv id', () => {
    const shapes = [
      makeTelemetry({ pv1PowerW: 900, pv2PowerW: 850 }),
      makeTelemetry({ pvPowerW: 1200, pvTotalPowerW: 1200 }),
      makeTelemetry({ pv1PowerW: null, pv2PowerW: null }),
    ];
    for (const telemetry of shapes) {
      expect(pvOptionalCapabilities(telemetry)).not.toContain(
        'measure_power.pv'
      );
    }
  });
});

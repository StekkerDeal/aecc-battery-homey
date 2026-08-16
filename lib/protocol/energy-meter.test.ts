import { describe, expect, it } from 'vitest';
import {
  EnergyIntegrator,
  METER_PERSIST_DELTA_KWH,
  METER_PERSIST_INTERVAL_MS,
  shouldPersistMeter,
  type ShouldPersistMeterInput,
} from './energy-meter';

describe('EnergyIntegrator', () => {
  it('does nothing on the first sample (no previous timestamp)', () => {
    const meter = new EnergyIntegrator();
    const integrated = meter.sample(0, 1000);
    expect(integrated).toBe(false);
    expect(meter.chargedKwh).toBe(0);
    expect(meter.dischargedKwh).toBe(0);
  });

  it('integrates a positive (charging) power sample over one hour', () => {
    const meter = new EnergyIntegrator(undefined, { maxGapMs: 3_600_000 });
    meter.sample(0, 1000);
    const integrated = meter.sample(3_600_000, 1000);
    expect(integrated).toBe(true);
    expect(meter.chargedKwh).toBeCloseTo(1, 6);
    expect(meter.dischargedKwh).toBe(0);
  });

  it('integrates a negative (discharging) power sample over one hour', () => {
    const meter = new EnergyIntegrator(undefined, { maxGapMs: 3_600_000 });
    meter.sample(0, -500);
    meter.sample(3_600_000, -500);
    expect(meter.dischargedKwh).toBeCloseTo(0.5, 6);
    expect(meter.chargedKwh).toBe(0);
  });

  it('a 61 second gap contributes nothing', () => {
    const meter = new EnergyIntegrator();
    meter.sample(0, 1000);
    const integrated = meter.sample(61_000, 1000);
    expect(integrated).toBe(false);
    expect(meter.chargedKwh).toBe(0);
  });

  it('a gap exactly at maxGapMs integrates', () => {
    const meter = new EnergyIntegrator(undefined, { maxGapMs: 60_000 });
    meter.sample(0, 3600);
    const integrated = meter.sample(60_000, 3600);
    expect(integrated).toBe(true);
    expect(meter.chargedKwh).toBeCloseTo(0.06, 6);
  });

  it('respects a custom maxGapMs', () => {
    const meter = new EnergyIntegrator(undefined, { maxGapMs: 5000 });
    meter.sample(0, 1000);
    const integrated = meter.sample(5001, 1000);
    expect(integrated).toBe(false);
  });

  it('skips a non-positive delta (same or earlier timestamp)', () => {
    const meter = new EnergyIntegrator();
    meter.sample(1000, 500);
    expect(meter.sample(1000, 500)).toBe(false);
    expect(meter.sample(500, 500)).toBe(false);
  });

  it('rejects a non-finite power sample', () => {
    const meter = new EnergyIntegrator();
    meter.sample(0, 1000);
    const integrated = meter.sample(1000, Number.NaN);
    expect(integrated).toBe(false);
    expect(meter.chargedKwh).toBe(0);
  });

  it('serializes and restores counters', () => {
    const meter = new EnergyIntegrator();
    meter.sample(0, 1000);
    meter.sample(30_000, 1000); // 30s gap, within the default 60s max
    const state = meter.serialize();
    expect(state.chargedKwh).toBeGreaterThan(0);

    const restored = new EnergyIntegrator(state);
    expect(restored.chargedKwh).toBe(state.chargedKwh);
    expect(restored.dischargedKwh).toBe(state.dischargedKwh);
  });

  it('a deserialised integrator does not integrate the downtime gap', () => {
    const meter = new EnergyIntegrator();
    meter.sample(0, 1000);
    meter.sample(30_000, 1000); // real integration, within the default gap
    const state = meter.serialize();
    expect(state.chargedKwh).toBeGreaterThan(0);

    // Simulate a restart far in the future: new instance, same counters, no
    // in-memory timestamp, so the implied downtime gap is never integrated.
    const restored = new EnergyIntegrator(state);
    const integrated = restored.sample(10_000_000, 1000);
    expect(integrated).toBe(false);
    expect(restored.chargedKwh).toBe(state.chargedKwh);
  });

  it('counters never decrease across mixed charge/discharge samples', () => {
    const meter = new EnergyIntegrator();
    let chargedPrev = meter.chargedKwh;
    let dischargedPrev = meter.dischargedKwh;
    const powers = [1000, -500, 800, -1200, 0, 300];
    let t = 0;
    for (const p of powers) {
      meter.sample(t, p);
      expect(meter.chargedKwh).toBeGreaterThanOrEqual(chargedPrev);
      expect(meter.dischargedKwh).toBeGreaterThanOrEqual(dischargedPrev);
      chargedPrev = meter.chargedKwh;
      dischargedPrev = meter.dischargedKwh;
      t += 10_000;
    }
  });

  it('reset zeroes counters and clears the in-memory timestamp', () => {
    const meter = new EnergyIntegrator();
    meter.sample(0, 1000);
    meter.sample(3_600_000, 1000);
    meter.reset();
    expect(meter.chargedKwh).toBe(0);
    expect(meter.dischargedKwh).toBe(0);
    expect(meter.sample(3_600_001, 1000)).toBe(false);
  });
});

describe('shouldPersistMeter', () => {
  const baseline: ShouldPersistMeterInput = {
    currentChargedKwh: 1,
    currentDischargedKwh: 1,
    lastPersistedChargedKwh: 1,
    lastPersistedDischargedKwh: 1,
    nowMs: 0,
    lastPersistedAtMs: 0,
  };

  it('does not persist below both the kWh delta and the time interval', () => {
    const input: ShouldPersistMeterInput = {
      ...baseline,
      currentChargedKwh: 1 + METER_PERSIST_DELTA_KWH / 2,
      nowMs: METER_PERSIST_INTERVAL_MS - 1,
    };
    expect(shouldPersistMeter(input)).toBe(false);
  });

  it('persists once the charged kWh delta crosses the threshold', () => {
    const input: ShouldPersistMeterInput = {
      ...baseline,
      currentChargedKwh:
        baseline.lastPersistedChargedKwh + METER_PERSIST_DELTA_KWH * 2,
    };
    expect(shouldPersistMeter(input)).toBe(true);
  });

  it('persists once the discharged kWh delta crosses the threshold', () => {
    const input: ShouldPersistMeterInput = {
      ...baseline,
      currentDischargedKwh:
        baseline.lastPersistedDischargedKwh + METER_PERSIST_DELTA_KWH * 2,
    };
    expect(shouldPersistMeter(input)).toBe(true);
  });

  it('persists once the time interval since the last flush elapses', () => {
    const input: ShouldPersistMeterInput = {
      ...baseline,
      nowMs: METER_PERSIST_INTERVAL_MS,
    };
    expect(shouldPersistMeter(input)).toBe(true);
  });

  it('either counter moving alone is enough, independent of the other', () => {
    const chargedOnly: ShouldPersistMeterInput = {
      ...baseline,
      currentChargedKwh:
        baseline.lastPersistedChargedKwh + METER_PERSIST_DELTA_KWH * 2,
      currentDischargedKwh: baseline.lastPersistedDischargedKwh,
    };
    const dischargedOnly: ShouldPersistMeterInput = {
      ...baseline,
      currentChargedKwh: baseline.lastPersistedChargedKwh,
      currentDischargedKwh:
        baseline.lastPersistedDischargedKwh + METER_PERSIST_DELTA_KWH * 2,
    };
    expect(shouldPersistMeter(chargedOnly)).toBe(true);
    expect(shouldPersistMeter(dischargedOnly)).toBe(true);
  });

  it('a delta just below the threshold does not persist on its own', () => {
    const input: ShouldPersistMeterInput = {
      ...baseline,
      currentChargedKwh:
        baseline.lastPersistedChargedKwh + METER_PERSIST_DELTA_KWH - 0.0001,
    };
    expect(shouldPersistMeter(input)).toBe(false);
  });
});

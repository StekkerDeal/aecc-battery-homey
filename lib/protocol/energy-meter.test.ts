import { describe, expect, it } from 'vitest';
import {
  EnergyIntegrator,
  METER_PERSIST_DELTA_KWH,
  METER_PERSIST_INTERVAL_MS,
  ProductionIntegrator,
  shouldPersistMeter,
  shouldPersistProductionMeter,
  type ShouldPersistMeterInput,
  type ShouldPersistProductionMeterInput,
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

describe('ProductionIntegrator', () => {
  it('does nothing on the first sample (no previous timestamp)', () => {
    const meter = new ProductionIntegrator();
    const integrated = meter.sample(0, 1000);
    expect(integrated).toBe(false);
    expect(meter.generatedKwh).toBe(0);
  });

  it('integrates 1000 W held for one hour into exactly 1 kWh', () => {
    const meter = new ProductionIntegrator(undefined, { maxGapMs: 3_600_000 });
    meter.sample(0, 1000);
    const integrated = meter.sample(3_600_000, 1000);
    expect(integrated).toBe(true);
    expect(meter.generatedKwh).toBeCloseTo(1, 6);
  });

  it('a negative power contributes 0 but still advances the timestamp', () => {
    const meter = new ProductionIntegrator();
    meter.sample(0, 500); // establish the baseline timestamp
    const negativeResult = meter.sample(10_000, -300);
    expect(negativeResult).toBe(true);
    expect(meter.generatedKwh).toBe(0);

    // This interval runs from the negative sample's timestamp, not from 0,
    // so it must integrate over 10s, not 20s.
    const nextResult = meter.sample(20_000, 1000);
    expect(nextResult).toBe(true);
    expect(meter.generatedKwh).toBeCloseTo((1000 * 10_000) / 3.6e9, 9);
  });

  it('a gap longer than the default maxGapMs is skipped but still advances the timestamp', () => {
    const meter = new ProductionIntegrator();
    meter.sample(0, 1000);
    const gapResult = meter.sample(61_000, 1000);
    expect(gapResult).toBe(false);
    expect(meter.generatedKwh).toBe(0);

    // The next interval runs from the skipped sample's timestamp, so it
    // integrates cleanly over its own 10s gap.
    const nextResult = meter.sample(71_000, 1000);
    expect(nextResult).toBe(true);
    expect(meter.generatedKwh).toBeCloseTo((1000 * 10_000) / 3.6e9, 9);
  });

  it('rejects a non-finite power sample (NaN or Infinity)', () => {
    const meter = new ProductionIntegrator();
    meter.sample(0, 1000);
    expect(meter.sample(1000, Number.NaN)).toBe(false);
    expect(meter.generatedKwh).toBe(0);
    expect(meter.sample(2000, Number.POSITIVE_INFINITY)).toBe(false);
    expect(meter.generatedKwh).toBe(0);
  });

  it('skips a non-positive delta (same or earlier timestamp)', () => {
    const meter = new ProductionIntegrator();
    meter.sample(1000, 500);
    expect(meter.sample(1000, 500)).toBe(false);
    expect(meter.sample(500, 500)).toBe(false);
  });

  it('respects a custom maxGapMs', () => {
    const meter = new ProductionIntegrator(undefined, { maxGapMs: 5000 });
    meter.sample(0, 1000);
    const integrated = meter.sample(5001, 1000);
    expect(integrated).toBe(false);
  });

  it('restores generatedKwh from constructor state', () => {
    const meter = new ProductionIntegrator({ generatedKwh: 12.5 });
    expect(meter.generatedKwh).toBe(12.5);
  });

  it('serializes and restores the counter, serialising only generatedKwh', () => {
    const meter = new ProductionIntegrator();
    meter.sample(0, 1000);
    meter.sample(30_000, 1000); // 30s gap, within the default 60s max
    const state = meter.serialize();
    expect(state.generatedKwh).toBeGreaterThan(0);
    expect(Object.keys(state)).toEqual(['generatedKwh']);

    const restored = new ProductionIntegrator(state);
    expect(restored.generatedKwh).toBe(state.generatedKwh);
  });

  it('reset zeroes the counter and clears the in-memory timestamp', () => {
    const meter = new ProductionIntegrator();
    meter.sample(0, 1000);
    meter.sample(3_600_000, 1000);
    meter.reset();
    expect(meter.generatedKwh).toBe(0);
    expect(meter.sample(3_600_001, 1000)).toBe(false);
    expect(meter.generatedKwh).toBe(0);
  });
});

describe('shouldPersistProductionMeter', () => {
  const baseline: ShouldPersistProductionMeterInput = {
    currentGeneratedKwh: 1,
    lastPersistedGeneratedKwh: 1,
    nowMs: 0,
    lastPersistedAtMs: 0,
  };

  it('does not persist below both the kWh delta and the time interval', () => {
    const input: ShouldPersistProductionMeterInput = {
      ...baseline,
      currentGeneratedKwh: 1 + METER_PERSIST_DELTA_KWH / 2,
      nowMs: METER_PERSIST_INTERVAL_MS - 1,
    };
    expect(shouldPersistProductionMeter(input)).toBe(false);
  });

  it('persists once the generated kWh delta reaches the threshold exactly', () => {
    // A zero-valued baseline keeps the delta exactly at the threshold;
    // adding METER_PERSIST_DELTA_KWH onto a non-zero baseline and
    // subtracting it back out is not guaranteed to land on the same
    // floating-point value.
    const input: ShouldPersistProductionMeterInput = {
      ...baseline,
      currentGeneratedKwh: METER_PERSIST_DELTA_KWH,
      lastPersistedGeneratedKwh: 0,
    };
    expect(shouldPersistProductionMeter(input)).toBe(true);
  });

  it('persists once the generated kWh delta exceeds the threshold', () => {
    const input: ShouldPersistProductionMeterInput = {
      ...baseline,
      currentGeneratedKwh:
        baseline.lastPersistedGeneratedKwh + METER_PERSIST_DELTA_KWH * 2,
    };
    expect(shouldPersistProductionMeter(input)).toBe(true);
  });

  it('persists once the time interval since the last flush reaches exactly, even with no movement', () => {
    const input: ShouldPersistProductionMeterInput = {
      ...baseline,
      nowMs: METER_PERSIST_INTERVAL_MS,
    };
    expect(shouldPersistProductionMeter(input)).toBe(true);
  });
});

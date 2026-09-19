import { describe, expect, it } from 'vitest';
import { sessionOptionsFrom } from './session-factory';
import type { AeccDeviceSettings } from './device-settings';
import type { Scheduler } from '../session';

function buildSettings(
  overrides: Partial<AeccDeviceSettings> = {}
): AeccDeviceSettings {
  return {
    host: '192.168.1.40',
    port: 8080,
    pollIntervalS: 5,
    brand: 'jet',
    maxChargePowerW: 800,
    maxDischargePowerW: 800,
    verifyIntervalS: 60,
    ...overrides,
  };
}

function fakeScheduler(): Scheduler {
  return {
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
    now: () => 0,
  };
}

describe('sessionOptionsFrom', () => {
  it('passes host, port and brand through unchanged', () => {
    const settings = buildSettings({
      host: '10.0.0.5',
      port: 502,
      brand: 'aeg',
    });

    const options = sessionOptionsFrom(settings, fakeScheduler());

    expect(options.host).toBe('10.0.0.5');
    expect(options.port).toBe(502);
    expect(options.brand).toBe('aeg');
  });

  it('maps maxChargePowerW and maxDischargePowerW into limits', () => {
    const settings = buildSettings({
      maxChargePowerW: 1200,
      maxDischargePowerW: 1500,
    });

    const options = sessionOptionsFrom(settings, fakeScheduler());

    expect(options.limits).toEqual({
      maxChargeW: 1200,
      maxDischargeW: 1500,
    });
  });

  // Two different values so a swapped seconds/milliseconds pair, or a
  // swapped poll/verify pair, would fail rather than passing by accident.
  it('converts pollIntervalS and verifyIntervalS to milliseconds', () => {
    const settings = buildSettings({
      pollIntervalS: 5,
      verifyIntervalS: 90,
    });

    const options = sessionOptionsFrom(settings, fakeScheduler());

    expect(options.pollIntervalMs).toBe(5000);
    expect(options.verifyIntervalMs).toBe(90000);
  });

  it('returns the same scheduler instance by reference', () => {
    const settings = buildSettings();
    const scheduler = fakeScheduler();

    const options = sessionOptionsFrom(settings, scheduler);

    expect(options.scheduler).toBe(scheduler);
  });
});

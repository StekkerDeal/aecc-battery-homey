import { describe, expect, it } from 'vitest';
import { settingsFrom, type RawSettings } from './device-settings';
import { MAX_REGISTER_POWER_DEFAULT } from '../protocol/registers';

describe('settingsFrom', () => {
  it('maps every snake_case key to its camelCase field', () => {
    const raw: RawSettings = {
      host: '192.168.1.50',
      port: 8080,
      poll_interval: 10,
      brand: 'aeg',
      max_charge_power: 1200,
      max_discharge_power: 1500,
      verify_interval: 30,
    };

    expect(settingsFrom(raw)).toEqual({
      host: '192.168.1.50',
      port: 8080,
      pollIntervalS: 10,
      brand: 'aeg',
      maxChargePowerW: 1200,
      maxDischargePowerW: 1500,
      verifyIntervalS: 30,
    });
  });

  it('defaults host to an empty string when absent', () => {
    expect(settingsFrom({}).host).toBe('');
  });

  it('defaults port to 0 when absent', () => {
    expect(settingsFrom({}).port).toBe(0);
  });

  it('defaults pollIntervalS to 5 when poll_interval is absent', () => {
    expect(settingsFrom({}).pollIntervalS).toBe(5);
  });

  it('defaults brand to other when absent', () => {
    expect(settingsFrom({}).brand).toBe('other');
  });

  it('defaults maxChargePowerW to MAX_REGISTER_POWER_DEFAULT when absent', () => {
    expect(settingsFrom({}).maxChargePowerW).toBe(MAX_REGISTER_POWER_DEFAULT);
  });

  it('defaults maxDischargePowerW to MAX_REGISTER_POWER_DEFAULT when absent', () => {
    expect(settingsFrom({}).maxDischargePowerW).toBe(
      MAX_REGISTER_POWER_DEFAULT
    );
  });

  it('defaults verifyIntervalS to 60 when verify_interval is absent', () => {
    expect(settingsFrom({}).verifyIntervalS).toBe(60);
  });

  it('applies all defaults together for a fully empty settings object', () => {
    expect(settingsFrom({})).toEqual({
      host: '',
      port: 0,
      pollIntervalS: 5,
      brand: 'other',
      maxChargePowerW: MAX_REGISTER_POWER_DEFAULT,
      maxDischargePowerW: MAX_REGISTER_POWER_DEFAULT,
      verifyIntervalS: 60,
    });
  });

  it('applies the same defaults when the keys are explicitly null or undefined', () => {
    const raw: RawSettings = {
      host: null,
      port: undefined,
      poll_interval: null,
      brand: undefined,
      max_charge_power: null,
      max_discharge_power: undefined,
      verify_interval: null,
    };

    expect(settingsFrom(raw)).toEqual({
      host: '',
      port: 0,
      pollIntervalS: 5,
      brand: 'other',
      maxChargePowerW: MAX_REGISTER_POWER_DEFAULT,
      maxDischargePowerW: MAX_REGISTER_POWER_DEFAULT,
      verifyIntervalS: 60,
    });
  });
});

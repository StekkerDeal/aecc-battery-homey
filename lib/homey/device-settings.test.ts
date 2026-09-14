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

  // The settings page offers 2500W to every brand because Homey cannot vary a
  // field's range per device, so the brand's real ceiling binds here instead.
  it('caps both power limits at the brand ceiling', () => {
    const raw: RawSettings = {
      brand: 'jet',
      max_charge_power: 2500,
      max_discharge_power: 2500,
    };

    expect(settingsFrom(raw).maxChargePowerW).toBe(2400);
    expect(settingsFrom(raw).maxDischargePowerW).toBe(2400);
  });

  it('lets TSUN keep 2500W', () => {
    const raw: RawSettings = {
      brand: 'tsun',
      max_charge_power: 2500,
      max_discharge_power: 2500,
    };

    expect(settingsFrom(raw).maxChargePowerW).toBe(2500);
    expect(settingsFrom(raw).maxDischargePowerW).toBe(2500);
  });

  it('leaves a value below the ceiling untouched', () => {
    const raw: RawSettings = {
      brand: 'tsun',
      max_charge_power: 800,
      max_discharge_power: 1200,
    };

    expect(settingsFrom(raw).maxChargePowerW).toBe(800);
    expect(settingsFrom(raw).maxDischargePowerW).toBe(1200);
  });

  it('caps an unbranded device at the default ceiling', () => {
    const raw: RawSettings = {
      max_charge_power: 9000,
      max_discharge_power: 9000,
    };

    expect(settingsFrom(raw).maxChargePowerW).toBe(2400);
    expect(settingsFrom(raw).maxDischargePowerW).toBe(2400);
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

import { describe, expect, it } from 'vitest';
import {
  DEVICE_MANAGEMENT_SAFE_REGISTERS,
  DM_FIRMWARE,
  DM_MODEL,
  DM_RSSI,
  DM_SERIAL,
  MAX_REGISTER_POWER_DEFAULT,
  REG_AI_SMART_CHARGE,
  REG_AI_SMART_DISC,
  REG_CONTROL_TIME1,
  REG_CUSTOM_MODE,
  REG_EMS_ENABLE,
  REG_MAX_FEED_POWER,
  REG_MAX_SOC,
  REG_MIN_SOC,
  REG_SCHEDULE_MODE,
  SLOT_DISABLED,
} from './registers';

describe('registers', () => {
  it('exposes the confirmed register addresses', () => {
    expect(REG_EMS_ENABLE).toBe('3000');
    expect(REG_CONTROL_TIME1).toBe('3003');
    expect(REG_SCHEDULE_MODE).toBe('3020');
    expect(REG_AI_SMART_CHARGE).toBe('3021');
    expect(REG_AI_SMART_DISC).toBe('3022');
    expect(REG_MIN_SOC).toBe('3023');
    expect(REG_MAX_SOC).toBe('3024');
    expect(REG_CUSTOM_MODE).toBe('3030');
    expect(REG_MAX_FEED_POWER).toBe('3039');
  });

  it('exposes the idle slot string and power limits', () => {
    expect(SLOT_DISABLED).toBe('0,00:00,00:00,0,0,0,0,0,0,100,10');
    expect(MAX_REGISTER_POWER_DEFAULT).toBe(800);
  });

  it('DEVICE_MANAGEMENT_SAFE_REGISTERS contains exactly the identity/RSSI set', () => {
    expect(DEVICE_MANAGEMENT_SAFE_REGISTERS).toEqual([2, 8, 9, 20, 21, 76]);
  });

  it('never whitelists the WiFi credential registers 56 and 57', () => {
    expect(DEVICE_MANAGEMENT_SAFE_REGISTERS).not.toContain(56);
    expect(DEVICE_MANAGEMENT_SAFE_REGISTERS).not.toContain(57);
  });

  it('exposes named DeviceManagement accessors matching the safe list', () => {
    expect(DM_SERIAL).toBe('8');
    expect(DM_MODEL).toBe('20');
    expect(DM_FIRMWARE).toBe('21');
    expect(DM_RSSI).toBe('76');
  });
});

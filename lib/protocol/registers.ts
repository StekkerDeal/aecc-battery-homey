// Control register addresses confirmed by register scan on real AECC devices.
export const REG_EMS_ENABLE = '3000';
export const REG_CONTROL_TIME1 = '3003';
export const REG_SCHEDULE_MODE = '3020';
export const REG_AI_SMART_CHARGE = '3021';
export const REG_AI_SMART_DISC = '3022';
export const REG_MIN_SOC = '3023';
export const REG_MAX_SOC = '3024';
export const REG_CUSTOM_MODE = '3030';
export const REG_MAX_FEED_POWER = '3039';

// Idle schedule slot: clears the active time slot so the firmware will not
// auto-re-enable EMS after a disable.
export const SLOT_DISABLED = '0,00:00,00:00,0,0,0,0,0,0,100,10';

export const MAX_BATTERY_POWER_W = 2400;
export const MAX_REGISTER_POWER_DEFAULT = 800;

// DeviceManagement register whitelist: identity and RSSI only. Registers 56
// and 57 return the WiFi SSID and password in cleartext, so this list must
// never be widened and raw DeviceManagement responses must never be logged.
export const DEVICE_MANAGEMENT_SAFE_REGISTERS = [2, 8, 9, 20, 21, 76] as const;

export const DM_SERIAL = '8';
export const DM_MODEL = '20';
export const DM_FIRMWARE = '21';
export const DM_RSSI = '76';

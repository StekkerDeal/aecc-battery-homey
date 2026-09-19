import type { AeccSessionOptions, Scheduler } from '../session';
import type { AeccDeviceSettings } from './device-settings';

/**
 * Builds the session options for one datalogger from a device's settings.
 *
 * Extracted from the battery device because two drivers now share a single
 * session per battery, and whichever of them initialises first is the one
 * that constructs it. Both have to build an identical session, so the
 * seconds-to-milliseconds conversions and the limits mapping live here
 * rather than being spelled out twice.
 *
 * The scheduler is passed in: it is the one piece that is genuinely per
 * device, since it wraps that device's own homey.setTimeout.
 */
export function sessionOptionsFrom(
  settings: AeccDeviceSettings,
  scheduler: Scheduler
): AeccSessionOptions {
  return {
    host: settings.host,
    port: settings.port,
    brand: settings.brand,
    limits: {
      maxChargeW: settings.maxChargePowerW,
      maxDischargeW: settings.maxDischargePowerW,
    },
    scheduler,
    pollIntervalMs: settings.pollIntervalS * 1000,
    verifyIntervalMs: settings.verifyIntervalS * 1000,
  };
}

import type { BrandProfile } from './brands';

export interface CleanerContext {
  key: string;
  rawValue: number;
  lastAcceptedValue: number | null;
  lastAcceptedAtMs: number | null;
  nowMs: number;
  /** Signed wall-side power: positive = charging, negative = discharging. */
  wallPowerW: number | null;
  profile: BrandProfile;
}

export type Cleaner = (ctx: CleanerContext) => number | null;

// Reject SOC readings that contradict observable physics: a 0 while the
// wall-side power shows active flow above the brand threshold, or a change
// rate since the last accepted sample beyond the brand's max %/min.
export function cleanSoc(ctx: CleanerContext): number | null {
  const { rawValue, profile } = ctx;

  if (
    rawValue === 0 &&
    ctx.wallPowerW !== null &&
    Math.abs(ctx.wallPowerW) > profile.socZeroRejectDuringActiveW
  ) {
    return null;
  }

  if (
    ctx.lastAcceptedValue !== null &&
    ctx.lastAcceptedAtMs !== null &&
    ctx.nowMs > ctx.lastAcceptedAtMs
  ) {
    const elapsedSeconds = (ctx.nowMs - ctx.lastAcceptedAtMs) / 1000;
    // Sub-poll-interval calls (multiple sensors reading the same tick) would
    // otherwise see huge %/min from a millisecond gap; real polls are >=2s.
    if (elapsedSeconds >= 1.0) {
      const elapsedMin = elapsedSeconds / 60;
      const changePerMin =
        Math.abs(rawValue - ctx.lastAcceptedValue) / elapsedMin;
      if (changePerMin > profile.socMaxRatePctPerMin) return null;
    }
  }

  return rawValue;
}

// Power sensors deliberately have no cleaner: wallPowerW cannot tell which
// source (AC, PV, battery) drives the activity, which caused two real
// regressions (a discharge and a PV-charging false rejection).
export const CLEANERS: Record<string, Cleaner> = {
  battery_soc: cleanSoc,
};

import { describe, expect, it } from 'vitest';
import { BRAND_PROFILES } from './brands';
import { CLEANERS, cleanSoc, type CleanerContext } from './cleaners';

const otherProfile = BRAND_PROFILES.other; // { socZeroRejectDuringActiveW: 100, socMaxRatePctPerMin: 8.0 }

function ctx(overrides: Partial<CleanerContext>): CleanerContext {
  return {
    key: 'battery_soc',
    rawValue: 50,
    lastAcceptedValue: null,
    lastAcceptedAtMs: null,
    nowMs: 0,
    wallPowerW: null,
    profile: otherProfile,
    ...overrides,
  };
}

describe('cleanSoc', () => {
  it('accepts a plausible reading with no prior history', () => {
    expect(cleanSoc(ctx({ rawValue: 42 }))).toBe(42);
  });

  it('rejects SOC=0 while wall power exceeds the profile threshold', () => {
    const result = cleanSoc(ctx({ rawValue: 0, wallPowerW: 150 }));
    expect(result).toBeNull();
  });

  it('rejects SOC=0 for a negative (discharging) wall power beyond threshold', () => {
    expect(cleanSoc(ctx({ rawValue: 0, wallPowerW: -150 }))).toBeNull();
  });

  it('accepts SOC=0 when wall power is within the threshold', () => {
    expect(cleanSoc(ctx({ rawValue: 0, wallPowerW: 50 }))).toBe(0);
  });

  it('accepts SOC=0 when wall power is unknown', () => {
    expect(cleanSoc(ctx({ rawValue: 0, wallPowerW: null }))).toBe(0);
  });

  it('rejects a change rate exceeding the profile max after >=1s elapsed', () => {
    const result = cleanSoc(
      ctx({
        rawValue: 90,
        lastAcceptedValue: 50,
        lastAcceptedAtMs: 0,
        nowMs: 60_000, // 1 minute elapsed, 40 pp/min >> 8 pp/min max
      })
    );
    expect(result).toBeNull();
  });

  it('accepts a change rate within the profile max', () => {
    const result = cleanSoc(
      ctx({
        rawValue: 55,
        lastAcceptedValue: 50,
        lastAcceptedAtMs: 0,
        nowMs: 60_000, // 5 pp/min < 8 pp/min max
      })
    );
    expect(result).toBe(55);
  });

  it('skips the rate check for sub-poll-interval calls (elapsed < 1s)', () => {
    const result = cleanSoc(
      ctx({
        rawValue: 90,
        lastAcceptedValue: 50,
        lastAcceptedAtMs: 0,
        nowMs: 500, // 0.5s elapsed: below the 1s floor
      })
    );
    expect(result).toBe(90);
  });

  it('treats exactly 1.0s elapsed as eligible for the rate check', () => {
    const result = cleanSoc(
      ctx({
        rawValue: 99,
        lastAcceptedValue: 0,
        lastAcceptedAtMs: 0,
        nowMs: 1000, // exactly 1s: 99pp in 1/60 min = 5940pp/min, way over
      })
    );
    expect(result).toBeNull();
  });

  it('skips the rate check when now equals lastAcceptedAtMs', () => {
    const result = cleanSoc(
      ctx({
        rawValue: 90,
        lastAcceptedValue: 10,
        lastAcceptedAtMs: 5000,
        nowMs: 5000,
      })
    );
    expect(result).toBe(90);
  });
});

describe('CLEANERS', () => {
  it('registers cleanSoc under battery_soc and nothing else', () => {
    expect(CLEANERS.battery_soc).toBe(cleanSoc);
    expect(Object.keys(CLEANERS)).toEqual(['battery_soc']);
  });
});

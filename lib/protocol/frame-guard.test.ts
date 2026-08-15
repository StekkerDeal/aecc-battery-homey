import { describe, expect, it } from 'vitest';
import type { EnergyFrame } from '../types';
import { FrameGuard } from './frame-guard';

const fullSerial = 'FULLSERIAL1234567890';

function frameWith(soc: number, sn = fullSerial): EnergyFrame {
  return { Storage_list: [{ StorageSN: sn, BatterySoc: soc }] };
}

describe('FrameGuard', () => {
  it('accepts the first frame unconditionally (no prior good frame)', () => {
    const guard = new FrameGuard();
    const result = guard.accept(frameWith(50));
    expect(result.held).toBe(false);
    expect(result.suspectReason).toBeNull();
  });

  it('holds the last good frame when a previously present unit disappears', () => {
    const guard = new FrameGuard();
    const good = frameWith(50);
    guard.accept(good);

    const withoutUnit: EnergyFrame = { Storage_list: [] };
    const result = guard.accept(withoutUnit);
    expect(result.held).toBe(true);
    expect(result.frame).toEqual(good);
    expect(result.suspectReason).toMatch(/missing from Storage_list/);
  });

  it('holds when a unit SOC collapses to 0 from at or above the floor', () => {
    const guard = new FrameGuard();
    const good = frameWith(10);
    guard.accept(good);

    const collapsed = frameWith(0);
    const result = guard.accept(collapsed);
    expect(result.held).toBe(true);
    expect(result.frame).toEqual(good);
    expect(result.suspectReason).toMatch(/SOC collapsed from 10 to 0/);
  });

  it('does not flag a SOC collapse to 0 from below the floor', () => {
    const guard = new FrameGuard({ socCollapseFloor: 5 });
    guard.accept(frameWith(4));
    const result = guard.accept(frameWith(0));
    expect(result.held).toBe(false);
    expect(result.suspectReason).toBeNull();
  });

  it('accepts the fourth consecutive suspect frame after the default tolerance of 3', () => {
    const guard = new FrameGuard();
    guard.accept(frameWith(10));

    const first = guard.accept(frameWith(0));
    const second = guard.accept(frameWith(0));
    const third = guard.accept(frameWith(0));
    const fourth = guard.accept(frameWith(0));

    expect(first.held).toBe(true);
    expect(second.held).toBe(true);
    expect(third.held).toBe(true);
    expect(fourth.held).toBe(false);
    expect(fourth.suspectReason).not.toBeNull();
  });

  it('never includes a full serial number in the suspect reason', () => {
    const guard = new FrameGuard();
    guard.accept(frameWith(10, fullSerial));
    const result = guard.accept(frameWith(0, fullSerial));
    expect(result.suspectReason).not.toContain(fullSerial);
    expect(result.suspectReason).toContain('SN ending 7890');
  });

  it('labels a missing unit by DevAddr when present', () => {
    const guard = new FrameGuard();
    guard.accept({
      Storage_list: [{ DevAddr: 3, StorageSN: fullSerial, BatterySoc: 10 }],
    });
    const result = guard.accept({ Storage_list: [] });
    expect(result.suspectReason).toContain('DevAddr 3');
    expect(result.suspectReason).not.toContain(fullSerial);
  });

  it('resets the suspect streak once a clean frame arrives', () => {
    const guard = new FrameGuard();
    guard.accept(frameWith(10));
    guard.accept(frameWith(0)); // 1 suspect, held
    const clean = frameWith(20);
    const result = guard.accept(clean);
    expect(result.held).toBe(false);

    // Streak reset: the next 3 suspects should be held again, not accepted.
    guard.accept(frameWith(0)); // new baseline soc 20
    const s1 = guard.accept(frameWith(0));
    expect(s1.held).toBe(true);
  });

  it('does not flag anything when the last good frame had no units', () => {
    const guard = new FrameGuard();
    guard.accept({ SSumInfoList: { AverageBatteryAverageSOC: 40 } });
    const result = guard.accept(frameWith(0));
    expect(result.held).toBe(false);
  });

  it('ignores non-numeric SOC values instead of flagging them', () => {
    const guard = new FrameGuard();
    guard.accept({ Storage_list: [{ StorageSN: 'A', BatterySoc: undefined }] });
    const result = guard.accept({
      Storage_list: [{ StorageSN: 'A', BatterySoc: 0 }],
    });
    expect(result.held).toBe(false);
  });

  it('respects a custom tolerance', () => {
    const guard = new FrameGuard({ tolerance: 1 });
    guard.accept(frameWith(10));
    const first = guard.accept(frameWith(0));
    const second = guard.accept(frameWith(0));
    expect(first.held).toBe(true);
    expect(second.held).toBe(false);
  });

  it('exposes running stats via the stats getter', () => {
    const guard = new FrameGuard();
    expect(guard.stats).toEqual({
      suspectFramesTotal: 0,
      lastReason: null,
      lastAt: null,
    });

    guard.accept(frameWith(10));
    guard.accept(frameWith(0));
    const stats = guard.stats;
    expect(stats.suspectFramesTotal).toBe(1);
    expect(stats.lastReason).toMatch(/SOC collapsed/);
    expect(stats.lastAt).not.toBeNull();
  });
});

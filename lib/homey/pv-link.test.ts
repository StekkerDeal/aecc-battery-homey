import { describe, expect, it, vi } from 'vitest';
import { followersOf, isPvFollower, type PvFollower } from './pv-link';

function fakeFollower(overrides: Partial<PvFollower> = {}): PvFollower {
  return {
    batteryDeviceId: 'battery-1',
    detachFromBattery: vi.fn().mockResolvedValue(undefined),
    attachToBattery: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('isPvFollower', () => {
  it('is true for an object with a string batteryDeviceId and both hooks as functions', () => {
    expect(isPvFollower(fakeFollower())).toBe(true);
  });

  const nonObjects: ReadonlyArray<[label: string, value: unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'battery-1'],
    ['a number', 42],
    ['an array', []],
  ];

  it.each(nonObjects)('is false for %s', (_label, value) => {
    expect(isPvFollower(value)).toBe(false);
  });

  it('is false when batteryDeviceId is missing', () => {
    const value: unknown = {
      detachFromBattery: vi.fn(),
      attachToBattery: vi.fn(),
    };

    expect(isPvFollower(value)).toBe(false);
  });

  it('is false when batteryDeviceId is not a string', () => {
    const value: unknown = { ...fakeFollower(), batteryDeviceId: 42 };

    expect(isPvFollower(value)).toBe(false);
  });

  it('is false when detachFromBattery is missing', () => {
    const value: unknown = {
      batteryDeviceId: 'battery-1',
      attachToBattery: vi.fn(),
    };

    expect(isPvFollower(value)).toBe(false);
  });

  it('is false when detachFromBattery is present but not a function', () => {
    const value: unknown = { ...fakeFollower(), detachFromBattery: 'nope' };

    expect(isPvFollower(value)).toBe(false);
  });

  it('is false when attachToBattery is missing', () => {
    const value: unknown = {
      batteryDeviceId: 'battery-1',
      detachFromBattery: vi.fn(),
    };

    expect(isPvFollower(value)).toBe(false);
  });

  it('is false when attachToBattery is present but not a function', () => {
    const value: unknown = { ...fakeFollower(), attachToBattery: 'nope' };

    expect(isPvFollower(value)).toBe(false);
  });
});

describe('followersOf', () => {
  it('returns only the followers whose batteryDeviceId matches the requested id', () => {
    const match = fakeFollower({ batteryDeviceId: 'battery-1' });
    const other = fakeFollower({ batteryDeviceId: 'battery-2' });

    expect(followersOf([match, other], 'battery-1')).toEqual([match]);
  });

  it('returns an empty array when nothing matches', () => {
    const other = fakeFollower({ batteryDeviceId: 'battery-2' });

    expect(followersOf([other], 'battery-1')).toEqual([]);
  });

  it('returns an empty array when the input list is empty', () => {
    expect(followersOf([], 'battery-1')).toEqual([]);
  });

  it('silently skips entries that are not followers at all, without throwing', () => {
    const bareObject: unknown = { foo: 'bar' };
    const deviceLikeWithNoHooks: unknown = { batteryDeviceId: 'battery-1' };
    const match = fakeFollower({ batteryDeviceId: 'battery-1' });
    const devices: readonly unknown[] = [
      bareObject,
      null,
      deviceLikeWithNoHooks,
      match,
    ];

    expect(() => followersOf(devices, 'battery-1')).not.toThrow();
    expect(followersOf(devices, 'battery-1')).toEqual([match]);
  });

  it('preserves input order and returns every match when more than one follower points at the same battery', () => {
    const first = fakeFollower({ batteryDeviceId: 'battery-1' });
    const second = fakeFollower({ batteryDeviceId: 'battery-2' });
    const third = fakeFollower({ batteryDeviceId: 'battery-1' });

    expect(followersOf([first, second, third], 'battery-1')).toEqual([
      first,
      third,
    ]);
  });

  it('returns the same references that were passed in, not copies', () => {
    const follower = fakeFollower();

    const [result] = followersOf([follower], follower.batteryDeviceId);

    expect(result).toBe(follower);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildPvPairDevice,
  findExistingPvForBattery,
  parseBatterySelection,
  toBatteryChoice,
  toBatteryChoices,
  type BatteryChoice,
  type BatteryDeviceLike,
  type PairedPvDeviceLike,
} from './driver-pairing';

function fakeDevice(name: string, data: unknown): BatteryDeviceLike {
  return {
    getName: () => name,
    getData: () => data,
  };
}

function fakePairedPvDevice(name: string, store: unknown): PairedPvDeviceLike {
  return {
    getName: () => name,
    getStore: () => store,
  };
}

describe('toBatteryChoice', () => {
  it('maps a device with a usable id and name', () => {
    const device = fakeDevice('Sunpura S2400', { id: 'ABC123' });
    expect(toBatteryChoice(device)).toEqual({
      id: 'ABC123',
      name: 'Sunpura S2400',
    });
  });

  it('returns null when the data has no id', () => {
    const device = fakeDevice('Sunpura S2400', {});
    expect(toBatteryChoice(device)).toBeNull();
  });

  it('returns null when id is an empty string', () => {
    const device = fakeDevice('Sunpura S2400', { id: '' });
    expect(toBatteryChoice(device)).toBeNull();
  });

  it('returns null when id is not a string', () => {
    const device = fakeDevice('Sunpura S2400', { id: 42 });
    expect(toBatteryChoice(device)).toBeNull();
  });

  it('returns null when getData() returns null', () => {
    const device = fakeDevice('Sunpura S2400', null);
    expect(toBatteryChoice(device)).toBeNull();
  });

  it('returns null when getData() returns a non-object', () => {
    const device = fakeDevice('Sunpura S2400', 42);
    expect(toBatteryChoice(device)).toBeNull();
  });
});

describe('toBatteryChoices', () => {
  it('skips devices that cannot be linked to and keeps the rest, preserving order', () => {
    const devices = [
      fakeDevice('First', { id: 'AAA' }),
      fakeDevice('No id', {}),
      fakeDevice('Second', { id: 'BBB' }),
      fakeDevice('Empty id', { id: '' }),
      fakeDevice('Third', { id: 'CCC' }),
    ];
    expect(toBatteryChoices(devices)).toEqual([
      { id: 'AAA', name: 'First' },
      { id: 'BBB', name: 'Second' },
      { id: 'CCC', name: 'Third' },
    ]);
  });

  it('returns [] for an empty list', () => {
    expect(toBatteryChoices([])).toEqual([]);
  });
});

describe('parseBatterySelection', () => {
  it('accepts a bare non-empty string', () => {
    expect(parseBatterySelection('ABC123')).toBe('ABC123');
  });

  it('accepts an object carrying the id', () => {
    expect(parseBatterySelection({ id: 'ABC123' })).toBe('ABC123');
  });

  it('throws for undefined', () => {
    expect(() => parseBatterySelection(undefined)).toThrow();
  });

  it('throws for null', () => {
    expect(() => parseBatterySelection(null)).toThrow();
  });

  it('throws for an empty object', () => {
    expect(() => parseBatterySelection({})).toThrow();
  });

  it('throws for an object with an empty id', () => {
    expect(() => parseBatterySelection({ id: '' })).toThrow();
  });

  it('throws for an object with a non-string id', () => {
    expect(() => parseBatterySelection({ id: 42 })).toThrow();
  });

  it('throws for an empty string', () => {
    expect(() => parseBatterySelection('')).toThrow();
  });

  it('throws for an array', () => {
    expect(() => parseBatterySelection(['ABC123'])).toThrow();
  });
});

describe('buildPvPairDevice', () => {
  const choice: BatteryChoice = { id: 'ABC123', name: 'Sunpura S2400' };

  it('builds the pair device with a PV-suffixed name, prefixed id and battery reference', () => {
    const device = buildPvPairDevice(choice);
    expect(device.name).toBe('Sunpura S2400 PV');
    expect(device.data.id).toBe('pv:ABC123');
    expect(device.store.batteryDeviceId).toBe('ABC123');
  });

  // Load-bearing: the PV device shares its battery's address on purpose, and
  // having no host/port settings is what keeps the battery driver's
  // collision guard from ever refusing it.
  it('carries no settings key at all', () => {
    const device = buildPvPairDevice(choice);
    expect('settings' in device).toBe(false);
    expect(Object.keys(device)).not.toContain('settings');
  });
});

describe('findExistingPvForBattery', () => {
  it('returns the device name when the store matches', () => {
    const devices = [
      fakePairedPvDevice('Sunpura S2400 PV', { batteryDeviceId: 'ABC123' }),
    ];
    expect(findExistingPvForBattery(devices, 'ABC123')).toBe(
      'Sunpura S2400 PV'
    );
  });

  it('returns null when nothing matches', () => {
    const devices = [
      fakePairedPvDevice('Other PV', { batteryDeviceId: 'XYZ789' }),
    ];
    expect(findExistingPvForBattery(devices, 'ABC123')).toBeNull();
  });

  it('returns null for an empty device list', () => {
    expect(findExistingPvForBattery([], 'ABC123')).toBeNull();
  });

  it('returns null when a store is null', () => {
    const devices = [fakePairedPvDevice('Some PV', null)];
    expect(findExistingPvForBattery(devices, 'ABC123')).toBeNull();
  });

  it('returns null when a store has no batteryDeviceId', () => {
    const devices = [fakePairedPvDevice('Some PV', {})];
    expect(findExistingPvForBattery(devices, 'ABC123')).toBeNull();
  });

  it('returns the first match when several match', () => {
    const devices = [
      fakePairedPvDevice('First PV', { batteryDeviceId: 'ABC123' }),
      fakePairedPvDevice('Second PV', { batteryDeviceId: 'ABC123' }),
    ];
    expect(findExistingPvForBattery(devices, 'ABC123')).toBe('First PV');
  });
});

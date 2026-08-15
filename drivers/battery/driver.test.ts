import { describe, expect, it, vi } from 'vitest';
import {
  applyBrandSettings,
  buildDeviceName,
  buildManualPairDevice,
  extractSelectedDevices,
  extractSelectedIds,
  findHostPortCollision,
  isMdnsSdResult,
  mapDiscoveryResultToPairDevice,
  parseManualConnectPayload,
  parseSetBrandPayload,
  resolveHost,
  resolvePort,
  resolveSerial,
  runConnectionProbe,
  type PairListDevice,
  type PairedDeviceLike,
  type ProbeClientLike,
} from './driver-pairing';
import type { DeviceIdentity } from '../../lib/types';
import type Homey from 'homey';

// Cast rather than implement the full EventEmitter surface DiscoveryResult
// inherits, matching the existing fakeSession() pattern in this codebase.
function fakeMdnsResult(
  address: string,
  txt: object
): Homey.DiscoveryResultMDNSSD {
  return {
    id: 'id',
    lastSeen: new Date(),
    address,
    port: '80',
    txt,
    name: 'SXD-mDNS-IF',
    fullname: 'SXD-mDNS-IF._http._tcp.local',
    host: 'aecc.local',
  } as unknown as Homey.DiscoveryResultMDNSSD;
}

function fakeSsdpResult(address: string): Homey.DiscoveryResultSSDP {
  return {
    id: 'id',
    lastSeen: new Date(),
    address,
    port: '80',
    headers: {},
  } as unknown as Homey.DiscoveryResultSSDP;
}

describe('resolvePort', () => {
  it('reads a numeric s_port TXT string', () => {
    expect(resolvePort({ s_port: '8080' })).toBe(8080);
  });

  it('falls back to 8080 when s_port is missing', () => {
    expect(resolvePort({})).toBe(8080);
  });

  it('falls back to 8080 when s_port is not numeric', () => {
    expect(resolvePort({ s_port: 'abc' })).toBe(8080);
  });

  it('accepts a numeric s_port value', () => {
    expect(resolvePort({ s_port: 9000 })).toBe(9000);
  });
});

describe('resolveHost', () => {
  it('prefers s_ip over the discovery address', () => {
    expect(resolveHost({ s_ip: '10.0.0.5' }, '192.168.1.1')).toBe('10.0.0.5');
  });

  it('falls back to the discovery address when s_ip is missing', () => {
    expect(resolveHost({}, '192.168.1.1')).toBe('192.168.1.1');
  });

  it('falls back when s_ip is blank', () => {
    expect(resolveHost({ s_ip: '   ' }, '192.168.1.1')).toBe('192.168.1.1');
  });
});

describe('resolveSerial', () => {
  it('trims a present s_sn', () => {
    expect(resolveSerial({ s_sn: ' AECC123 ' })).toBe('AECC123');
  });

  it('returns null when s_sn is missing', () => {
    expect(resolveSerial({})).toBeNull();
  });

  it('returns null when s_sn is blank', () => {
    expect(resolveSerial({ s_sn: '   ' })).toBeNull();
  });
});

describe('buildDeviceName', () => {
  it('uses the serial when known', () => {
    expect(buildDeviceName('AECC123', '192.168.1.1')).toBe(
      'AECC battery AECC123'
    );
  });

  it('falls back to the address or host when the serial is unknown', () => {
    expect(buildDeviceName(null, '192.168.1.1')).toBe(
      'AECC battery 192.168.1.1'
    );
  });
});

describe('isMdnsSdResult', () => {
  it('is true for a result with a txt property', () => {
    expect(isMdnsSdResult(fakeMdnsResult('192.168.1.50', {}))).toBe(true);
  });

  it('is false for a result without a txt property', () => {
    expect(isMdnsSdResult(fakeSsdpResult('192.168.1.50'))).toBe(false);
  });
});

describe('mapDiscoveryResultToPairDevice', () => {
  it('maps a full mDNS result with serial and s_ip', () => {
    const result = fakeMdnsResult('192.168.1.50', {
      s_sn: 'AECC123',
      s_ip: '10.0.0.5',
      s_port: '8080',
    });

    expect(mapDiscoveryResultToPairDevice(result)).toEqual({
      name: 'AECC battery AECC123',
      data: { id: 'AECC123' },
      store: { serial: 'AECC123' },
      settings: { host: '10.0.0.5', port: 8080 },
    });
  });

  it('falls back to host:port as the id when no serial is present', () => {
    const result = fakeMdnsResult('192.168.1.50', {});

    expect(mapDiscoveryResultToPairDevice(result)).toEqual({
      name: 'AECC battery 192.168.1.50',
      data: { id: '192.168.1.50:8080' },
      store: { serial: null },
      settings: { host: '192.168.1.50', port: 8080 },
    });
  });
});

describe('parseManualConnectPayload', () => {
  it('parses a well-formed payload', () => {
    expect(
      parseManualConnectPayload({
        host: ' 192.168.1.50 ',
        port: 8080,
        name: ' My battery ',
      })
    ).toEqual({ host: '192.168.1.50', port: 8080, name: 'My battery' });
  });

  it('defaults the port and blanks the name when missing', () => {
    expect(parseManualConnectPayload({ host: '192.168.1.50' })).toEqual({
      host: '192.168.1.50',
      port: 8080,
      name: '',
    });
  });

  it('does not throw on a malformed payload', () => {
    expect(parseManualConnectPayload(null)).toEqual({
      host: '',
      port: 8080,
      name: '',
    });
  });
});

describe('parseSetBrandPayload', () => {
  it('parses a well-formed payload', () => {
    expect(
      parseSetBrandPayload({
        brand: 'lunergy',
        model: ' L5000 ',
        max_charge_power: 1200,
        max_discharge_power: 1500,
      })
    ).toEqual({
      brand: 'lunergy',
      model: 'L5000',
      maxChargePowerW: 1200,
      maxDischargePowerW: 1500,
    });
  });

  it('falls back to other for an unknown brand', () => {
    expect(parseSetBrandPayload({ brand: 'not-a-brand' }).brand).toBe('other');
  });

  it('falls back to 800W for missing or invalid power limits', () => {
    const parsed = parseSetBrandPayload({
      brand: 'aeg',
      max_charge_power: -5,
    });
    expect(parsed.maxChargePowerW).toBe(800);
    expect(parsed.maxDischargePowerW).toBe(800);
  });
});

describe('buildManualPairDevice', () => {
  it('uses the identity serial as id and keeps model and firmware', () => {
    const identity: DeviceIdentity = {
      serial: 'AECC999',
      model: 'L5000',
      firmware: '1.2.3',
    };
    const device = buildManualPairDevice(
      { host: '192.168.1.50', port: 8080, name: '' },
      identity
    );
    expect(device.data.id).toBe('AECC999');
    expect(device.store.serial).toBe('AECC999');
    expect(device.settings.model).toBe('L5000');
    expect(device.settings.firmware).toBe('1.2.3');
    expect(device.name).toBe('AECC battery AECC999');
  });

  it('falls back to host:port as id when identity is null, a Lunergy timeout', () => {
    const device = buildManualPairDevice(
      { host: '192.168.1.50', port: 8080, name: '' },
      null
    );
    expect(device.data.id).toBe('192.168.1.50:8080');
    expect(device.store.serial).toBeNull();
    expect(device.settings.model).toBeUndefined();
  });

  it('prefers the user-entered display name', () => {
    const device = buildManualPairDevice(
      { host: '192.168.1.50', port: 8080, name: 'Kitchen battery' },
      null
    );
    expect(device.name).toBe('Kitchen battery');
  });
});

describe('applyBrandSettings', () => {
  const base: PairListDevice = {
    name: 'AECC battery 192.168.1.50',
    data: { id: '192.168.1.50:8080' },
    store: { serial: null },
    settings: { host: '192.168.1.50', port: 8080 },
  };

  it('merges brand and power limits', () => {
    const result = applyBrandSettings(base, {
      brand: 'aeg',
      model: '',
      maxChargePowerW: 1200,
      maxDischargePowerW: 1200,
    });
    expect(result.settings).toEqual({
      host: '192.168.1.50',
      port: 8080,
      brand: 'aeg',
      max_charge_power: 1200,
      max_discharge_power: 1200,
    });
  });

  it('keeps an identity-derived model when the typed model is empty', () => {
    const withModel: PairListDevice = {
      ...base,
      settings: { ...base.settings, model: 'L5000' },
    };
    const result = applyBrandSettings(withModel, {
      brand: 'lunergy',
      model: '',
      maxChargePowerW: 800,
      maxDischargePowerW: 800,
    });
    expect(result.settings.model).toBe('L5000');
  });

  it('overrides the model when the user typed one', () => {
    const result = applyBrandSettings(base, {
      brand: 'other',
      model: 'Custom model',
      maxChargePowerW: 800,
      maxDischargePowerW: 800,
    });
    expect(result.settings.model).toBe('Custom model');
  });
});

describe('extractSelectedIds', () => {
  it('reads ids from an array of full device objects', () => {
    const data = [{ data: { id: 'a' } }, { data: { id: 'b' } }];
    expect(extractSelectedIds(data)).toEqual(['a', 'b']);
  });

  it('reads ids from an array of bare id strings', () => {
    expect(extractSelectedIds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('reads a single non-array item', () => {
    expect(extractSelectedIds({ data: { id: 'a' } })).toEqual(['a']);
  });

  it('ignores malformed entries', () => {
    expect(extractSelectedIds([{}, null, { data: {} }])).toEqual([]);
  });
});

describe('extractSelectedDevices', () => {
  it('resolves selected ids against the discovery cache', () => {
    const deviceA: PairListDevice = {
      name: 'A',
      data: { id: 'a' },
      store: { serial: null },
      settings: { host: '1.1.1.1', port: 8080 },
    };
    const cache = new Map([['a', deviceA]]);
    expect(extractSelectedDevices(['a', 'unknown'], cache)).toEqual([deviceA]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(extractSelectedDevices(['missing'], new Map())).toEqual([]);
  });
});

describe('findHostPortCollision', () => {
  function fakeDevice(name: string, settings: unknown): PairedDeviceLike {
    return { getName: () => name, getSettings: () => settings };
  }

  it('names the existing device using the same host and port', () => {
    const devices = [
      fakeDevice('Kitchen battery', { host: '192.168.1.50', port: 8080 }),
    ];
    expect(findHostPortCollision(devices, '192.168.1.50', 8080)).toBe(
      'Kitchen battery'
    );
  });

  it('returns null when no device matches', () => {
    const devices = [
      fakeDevice('Kitchen battery', { host: '192.168.1.51', port: 8080 }),
    ];
    expect(findHostPortCollision(devices, '192.168.1.50', 8080)).toBeNull();
  });

  it('returns null for an empty device list', () => {
    expect(findHostPortCollision([], '192.168.1.50', 8080)).toBeNull();
  });
});

describe('runConnectionProbe', () => {
  function fakeClient(overrides: Partial<ProbeClientLike> = {}): {
    client: ProbeClientLike;
    disconnect: ReturnType<typeof vi.fn>;
  } {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const client: ProbeClientLike = {
      connect: vi.fn().mockResolvedValue(undefined),
      getEnergyParameters: vi
        .fn()
        .mockResolvedValue({ SSumInfoList: { TotalPVPower: 100 } }),
      getDeviceIdentity: vi.fn().mockResolvedValue(null),
      disconnect,
      ...overrides,
    };
    return { client, disconnect };
  }

  it('reports connect_failed and still disconnects when connect throws', async () => {
    const { client, disconnect } = fakeClient({
      connect: vi.fn().mockRejectedValue(new Error('timeout')),
    });

    const outcome = await runConnectionProbe(client);

    expect(outcome).toEqual({ ok: false, reason: 'connect_failed' });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('reports no_valid_data when getEnergyParameters returns null', async () => {
    const { client, disconnect } = fakeClient({
      getEnergyParameters: vi.fn().mockResolvedValue(null),
    });

    const outcome = await runConnectionProbe(client);

    expect(outcome).toEqual({ ok: false, reason: 'no_valid_data' });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('reports no_valid_data when the frame does not parse', async () => {
    const { client, disconnect } = fakeClient({
      getEnergyParameters: vi.fn().mockResolvedValue({}),
    });

    const outcome = await runConnectionProbe(client);

    expect(outcome).toEqual({ ok: false, reason: 'no_valid_data' });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('succeeds with the identity when everything responds', async () => {
    const identity: DeviceIdentity = { serial: 'AECC1' };
    const { client, disconnect } = fakeClient({
      getDeviceIdentity: vi.fn().mockResolvedValue(identity),
    });

    const outcome = await runConnectionProbe(client);

    expect(outcome).toEqual({ ok: true, identity });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('succeeds with a null identity when getDeviceIdentity fails, a Lunergy timeout', async () => {
    const { client, disconnect } = fakeClient({
      getDeviceIdentity: vi.fn().mockRejectedValue(new Error('timeout')),
    });

    const outcome = await runConnectionProbe(client);

    expect(outcome).toEqual({ ok: true, identity: null });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

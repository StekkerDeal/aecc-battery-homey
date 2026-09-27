import { describe, expect, it } from 'vitest';
import {
  buildDiagnostics,
  DIAGNOSTICS_MARKER,
  formatDiagnosticsLine,
  readControlRegistersSection,
  redact,
  REDACT_KEYS,
  REDACTED,
  REGISTER_RANGE,
  REGISTER_RANGE_FALLBACK,
  type ControlRegistersSection,
  type DiagnosticsInput,
} from './diagnostics';
import { ResponseShapeError } from './protocol/frames';
import type {
  SessionDiagnosticsState,
  SessionSnapshot,
  WriteHistoryEntry,
} from './session';

const FETCHED_AT_MS = Date.UTC(2026, 8, 27, 12, 0, 0);

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    brand: 'sunpura',
    telemetry: null,
    identity: { serial: 'S2400SERIAL', firmware: '1.4.9', model: 'S2400' },
    workMode: 'custom',
    commandedTargetPowerW: -600,
    minSoc: 12,
    maxSoc: 95,
    hasStorageList: true,
    available: true,
    consecutiveFailedPolls: 0,
    lastPollAtMs: 1000,
    lastGoodPollAtMs: 1000,
    frameGuard: {
      suspectStreak: 1,
      suspectFramesTotal: 3,
      lastReason: 'unit(s) missing from Storage_list: DevAddr 2',
      lastAt: '2026-09-27T11:59:00.000Z',
    },
    ...overrides,
  };
}

function state(
  overrides: Partial<SessionDiagnosticsState> = {}
): SessionDiagnosticsState {
  return {
    limits: { maxChargeW: 2400, maxDischargeW: 1200 },
    pollIntervalMs: 5000,
    initial: {
      minSoc: 10,
      maxSoc: 100,
      workMode: 'self_consumption',
      targetPowerW: 300,
    },
    lastRawFrame: {
      Response: 'EnergyParameter',
      SerialNumber: 42,
      Target: 'HA',
      Storage_list: [
        { DevAddr: 1, StorageSN: 'UNIT-ONE', BatterySoc: 44 },
        { DevAddr: 2, StorageSN: 'UNIT-TWO', BatterySoc: 44 },
      ],
      SSumInfoList: { TotalPVPower: 651, TotalChargePower: 600 },
    },
    cleanerLastAccepted: { battery_soc: 44 },
    cleanerLastAcceptedAtMs: { battery_soc: 1789081714409 },
    ...overrides,
  };
}

function writeEntry(n: number): WriteHistoryEntry {
  return {
    timestampMs: FETCHED_AT_MS + n,
    operation: `min_soc(${n}%)`,
    payload: { '3023': String(n) },
    attempts: 1,
    ok: true,
    verify: [
      {
        register: '3023',
        expected: String(n),
        actual: undefined,
        match: false,
      },
    ],
  };
}

function registers(): ControlRegistersSection {
  return {
    fetched_at: new Date(FETCHED_AT_MS).toISOString(),
    registers: { '3000': '1', '3023': '12' },
    key_registers: { 'EMS enable (3000)': '1', 'Min SOC (3023)': '12' },
    range: [3000, 3130],
    error: null,
  };
}

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    homeyVersion: '13.5.0',
    appVersion: '1.2.1',
    brand: 'sunpura',
    host: '192.168.1.77',
    port: 8080,
    snapshot: snapshot(),
    state: state(),
    writeHistory: [writeEntry(1)],
    controlRegisters: registers(),
    ...overrides,
  };
}

type Section = Record<string, unknown>;
type Dump = {
  homey: Section;
  data: {
    integration: Section;
    device: Section;
    config: Section;
    live_state: Section;
    cleaner_state: Section;
    modbus: Section;
    last_poll: Section;
    control_registers: Section;
    write_history: unknown;
  };
};

function build(overrides: Partial<DiagnosticsInput> = {}): Dump {
  return buildDiagnostics(input(overrides)) as Dump;
}

describe('REDACT_KEYS', () => {
  // Copied from the HA integration's diagnostics.py (_REDACT_KEYS). A
  // change there has to be made here too, and this list is the reminder.
  it('is exactly the Home Assistant integration set', () => {
    expect([...REDACT_KEYS].sort()).toEqual(
      [
        'host',
        'serial',
        'device_serial',
        'StorageSN',
        'datalogSn',
        'deviceSn',
        'password',
        'Password',
        'token',
        'Token',
        'secret',
        'api_key',
        'apiKey',
        'email',
        'ssid',
        'SSID',
        'wifi_password',
        'wifiPassword',
        'WifiPassword',
        'mac',
        'MAC',
        'mac_address',
        'macAddress',
        'latitude',
        'longitude',
      ].sort()
    );
  });
});

describe('redact', () => {
  it('replaces listed keys at any depth, inside arrays too', () => {
    const out = redact({
      host: '10.0.0.1',
      nested: { list: [{ StorageSN: 'X1', keep: 1 }, { ssid: 'Home' }] },
    });
    expect(out).toEqual({
      host: REDACTED,
      nested: { list: [{ StorageSN: REDACTED, keep: 1 }, { ssid: REDACTED }] },
    });
  });

  it('leaves null and empty values alone, as HA does', () => {
    expect(redact({ serial: null, host: '', mac: undefined })).toEqual({
      serial: null,
      host: '',
      mac: undefined,
    });
  });

  it('returns scalars unchanged and does not mutate its input', () => {
    expect(redact(5)).toBe(5);
    const source = { host: 'h' };
    redact(source);
    expect(source).toEqual({ host: 'h' });
  });
});

describe('buildDiagnostics', () => {
  it('writes every Home Assistant section, in HA order, under data', () => {
    const dump = build();
    expect(dump.homey).toEqual({ version: '13.5.0' });
    expect(Object.keys(dump.data)).toEqual([
      'integration',
      'device',
      'config',
      'live_state',
      'cleaner_state',
      'modbus',
      'last_poll',
      'control_registers',
      'write_history',
    ]);
  });

  it('uses the HA key names in every section', () => {
    const { data } = build();
    expect(Object.keys(data.integration)).toEqual([
      'domain',
      'version',
      'iot_class',
    ]);
    expect(Object.keys(data.device)).toEqual([
      'manufacturer',
      'model',
      'firmware_version',
      'device_serial',
      'host',
      'port',
      'unit_count',
    ]);
    expect(Object.keys(data.config)).toEqual([
      'max_charge_power',
      'max_discharge_power',
      'max_register_power',
      'brand_profile',
      'poll_interval_seconds',
    ]);
    expect(Object.keys(data.live_state)).toEqual([
      'last_update_success',
      'consecutive_failures',
      'commanded_power',
      'commanded_direction',
      'commanded_min_soc',
      'commanded_max_soc',
      'initial_min_soc',
      'initial_max_soc',
      'initial_work_mode',
      'current_work_mode',
      'initial_power',
      'suspect_streak',
      'suspect_frames_total',
      'last_suspect_reason',
      'last_suspect_at',
    ]);
    expect(Object.keys(data.cleaner_state)).toEqual([
      'last_accepted',
      'last_accepted_at',
    ]);
    expect(data.modbus).toEqual({
      supported: false,
      values: {},
      last_refresh_age_seconds: null,
      last_error: null,
    });
  });

  it('redacts host, the device serial and every unit serial', () => {
    const dump = build();
    const text = JSON.stringify(dump);
    expect(text).not.toContain('192.168.1.77');
    expect(text).not.toContain('S2400SERIAL');
    expect(text).not.toContain('UNIT-ONE');
    expect(text).not.toContain('UNIT-TWO');
    expect(dump.data.device.host).toBe(REDACTED);
    expect(dump.data.device.device_serial).toBe(REDACTED);
  });

  it('keeps the raw frame otherwise untouched, envelope included', () => {
    const lastPoll = build().data.last_poll as Record<string, unknown>;
    expect(lastPoll.Response).toBe('EnergyParameter');
    expect(lastPoll.SerialNumber).toBe(42);
    expect(lastPoll.SSumInfoList).toEqual({
      TotalPVPower: 651,
      TotalChargePower: 600,
    });
    expect(lastPoll.Storage_list).toEqual([
      { DevAddr: 1, StorageSN: REDACTED, BatterySoc: 44 },
      { DevAddr: 2, StorageSN: REDACTED, BatterySoc: 44 },
    ]);
  });

  it('fills device and config the way HA does', () => {
    const { data } = build();
    expect(data.device).toMatchObject({
      manufacturer: 'Sunpura',
      model: 'S2400',
      firmware_version: '1.4.9',
      port: 8080,
      unit_count: 2,
    });
    expect(data.config).toEqual({
      max_charge_power: 2400,
      max_discharge_power: 1200,
      max_register_power: 2400,
      brand_profile: {
        soc_zero_reject_during_active_w: expect.any(Number),
        soc_max_rate_pct_per_min: expect.any(Number),
        hold_last_value_seconds: expect.any(Number),
      },
      poll_interval_seconds: 5,
    });
  });

  it('converts power, direction and work modes to the HA conventions', () => {
    const { data } = build();
    expect(data.live_state).toMatchObject({
      last_update_success: true,
      commanded_power: 600,
      commanded_direction: 'Discharge',
      commanded_min_soc: 12,
      commanded_max_soc: 95,
      initial_min_soc: 10,
      initial_max_soc: 100,
      initial_work_mode: 'Self-Consumption (AI)',
      current_work_mode: 'Custom / Manual',
      initial_power: 300,
      suspect_streak: 1,
      suspect_frames_total: 3,
    });
    const charging = build({
      snapshot: snapshot({ commandedTargetPowerW: 800 }),
    });
    expect(charging.data.live_state.commanded_direction).toBe('Charge');
    const idle = build({ snapshot: snapshot({ commandedTargetPowerW: 0 }) });
    expect(idle.data.live_state.commanded_direction).toBe('Idle');
  });

  // HA's last_update_success stays true through failures within tolerance,
  // so one dropped poll must not read as an integration that is down.
  it('keeps last_update_success true through a failed poll until the battery is unavailable', () => {
    const blip = build({
      snapshot: snapshot({
        lastPollAtMs: 2000,
        lastGoodPollAtMs: 1000,
        consecutiveFailedPolls: 1,
      }),
    });
    expect(blip.data.live_state).toMatchObject({
      last_update_success: true,
      consecutive_failures: 1,
    });
    const down = build({
      snapshot: snapshot({ available: false, consecutiveFailedPolls: 5 }),
    });
    expect(down.data.live_state.last_update_success).toBe(false);
  });

  it('reports a session that never read its initial state', () => {
    const { data } = build({
      state: state({ initial: null, lastRawFrame: null }),
    });
    expect(data.live_state).toMatchObject({
      initial_min_soc: null,
      initial_max_soc: null,
      initial_work_mode: null,
      initial_power: null,
    });
    expect(data.last_poll).toEqual({});
    expect(data.device.unit_count).toBe(0);
  });

  it('gives cleaner timestamps in epoch seconds, as HA does', () => {
    const { data } = build();
    expect(data.cleaner_state).toEqual({
      last_accepted: { battery_soc: 44 },
      last_accepted_at: { battery_soc: 1789081714.409 },
    });
  });

  it('writes a missing verify as null, as HA does for a write that got no answer', () => {
    const unanswered: WriteHistoryEntry = {
      ...writeEntry(1),
      ok: false,
      attempts: 3,
      verify: null,
    };
    const writes = build({ writeHistory: [unanswered] }).data
      .write_history as unknown as Record<string, unknown>[];
    expect(writes[0]).toMatchObject({
      response_received: false,
      attempts: 3,
      verify_result: null,
    });
  });

  it('carries only the newest five writes, mapped to the HA keys', () => {
    const history = [1, 2, 3, 4, 5, 6, 7].map(writeEntry);
    const writes = build({ writeHistory: history }).data
      .write_history as unknown as Record<string, unknown>[];
    expect(writes.map(w => w.operation)).toEqual([
      'min_soc(3%)',
      'min_soc(4%)',
      'min_soc(5%)',
      'min_soc(6%)',
      'min_soc(7%)',
    ]);
    expect(writes[0]).toEqual({
      timestamp: new Date(FETCHED_AT_MS + 3).toISOString(),
      operation: 'min_soc(3%)',
      payload: { '3023': '3' },
      response_received: true,
      attempts: 1,
      verify_result: [
        { register: '3023', expected: '3', actual: null, match: false },
      ],
    });
  });

  // extract-from-diagnostics.mjs turns a dump into a simulator fixture by
  // reading exactly these two paths; a Homey dump has to keep them.
  it('keeps the two paths extract-from-diagnostics.mjs reads', () => {
    const { data } = build();
    expect(data.last_poll).toBeDefined();
    expect(
      (data.control_registers as unknown as ControlRegistersSection).registers
    ).toEqual({ '3000': '1', '3023': '12' });
  });
});

describe('readControlRegistersSection', () => {
  const now = (): number => FETCHED_AT_MS;

  it('reads the wide range and labels the key registers', async () => {
    const calls: number[][] = [];
    const section = await readControlRegistersSection(async addrs => {
      calls.push(addrs);
      return { '3000': '1', '3023': '10', '3130': '' };
    }, now);

    expect(calls).toEqual([REGISTER_RANGE]);
    expect(REGISTER_RANGE).toHaveLength(131);
    expect(section).toEqual({
      fetched_at: '2026-09-27T12:00:00.000Z',
      registers: { '3000': '1', '3023': '10', '3130': '' },
      key_registers: { 'EMS enable (3000)': '1', 'Min SOC (3023)': '10' },
      range: [3000, 3130],
      error: null,
    });
  });

  it('falls back to 3000-3039 when the wide read gets no answer', async () => {
    const calls: number[][] = [];
    const section = await readControlRegistersSection(async addrs => {
      calls.push(addrs);
      return calls.length === 1 ? null : { '3000': '1' };
    }, now);

    expect(calls).toEqual([REGISTER_RANGE, REGISTER_RANGE_FALLBACK]);
    expect(section.range).toEqual([3000, 3039]);
    expect(section.registers).toEqual({ '3000': '1' });
    expect(section.error).toBe('wide read returned no response');
  });

  it('records an answer without a register map as such, and does not retry', async () => {
    const calls: number[][] = [];
    const section = await readControlRegistersSection(async addrs => {
      calls.push(addrs);
      throw new ResponseShapeError(['Response', 'SerialNumber']);
    }, now);

    expect(calls).toHaveLength(1);
    expect(section.range).toEqual([3000, 3130]);
    expect(section.registers).toEqual({});
    expect(section.error).toBe(
      'unexpected response shape, keys=[Response, SerialNumber]'
    );
  });

  it('records both failures and never throws', async () => {
    const section = await readControlRegistersSection(async () => {
      throw new Error('socket closed');
    }, now);

    expect(section.registers).toEqual({});
    expect(section.key_registers).toEqual({});
    // HA only reports the fallback range once the fallback succeeded.
    expect(section.range).toEqual([3000, 3130]);
    expect(section.error).toBe(
      'wide read failed: socket closed; fallback also failed: socket closed'
    );
  });

  it('records a fallback that also gets no answer', async () => {
    const section = await readControlRegistersSection(async () => null, now);
    expect(section.error).toBe(
      'wide read returned no response; fallback also returned no response'
    );
  });
});

describe('formatDiagnosticsLine', () => {
  it('writes the marker, a space and the JSON on one line', () => {
    const line = formatDiagnosticsLine({ a: 1 });
    expect(line).toBe(`${DIAGNOSTICS_MARKER} {"a":1}`);
    expect(line).not.toContain('\n');
  });
});

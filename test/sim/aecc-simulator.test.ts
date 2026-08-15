import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AeccSimulator,
  type Scenario,
  type SimulatorOptions,
} from './aecc-simulator';
import {
  buildGet,
  buildSet,
  encodeRequest,
  JsonAccumulator,
} from '../../lib/protocol/frames';
import { systemValue } from '../../lib/protocol/telemetry';
import type { EnergyFrame } from '../../lib/types';
import jetSingleUnit from '../fixtures/jet-single-unit.json';

const NO_RESPONSE = Symbol('no-response');

// Drives the simulator like a real client: writes newline-terminated
// requests, reassembles responses with the real JsonAccumulator.
class TestClient {
  private readonly acc = new JsonAccumulator();
  private readonly buffered: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];

  private constructor(readonly socket: net.Socket) {
    socket.on('data', chunk => {
      // Socket never has setEncoding() called, so 'data' always emits a
      // Buffer; this narrows the wider `string | Buffer` event type down
      // to what JsonAccumulator.push expects.
      if (!Buffer.isBuffer(chunk)) return;
      const parsed = this.acc.push(chunk);
      if (parsed === null) return;
      this.acc.reset();
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.buffered.push(parsed);
    });
  }

  static async connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () =>
        resolve(new TestClient(socket))
      );
      socket.once('error', reject);
    });
  }

  send(payload: unknown): void {
    this.socket.write(encodeRequest(payload));
  }

  async nextResponse(): Promise<unknown> {
    if (this.buffered.length > 0) return this.buffered.shift();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async request(payload: unknown): Promise<unknown> {
    this.send(payload);
    return this.nextResponse();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

async function expectNoResponse(
  client: TestClient,
  withinMs = 150
): Promise<void> {
  const result = await Promise.race([
    client.nextResponse(),
    new Promise(resolve => setTimeout(() => resolve(NO_RESPONSE), withinMs)),
  ]);
  expect(result).toBe(NO_RESPONSE);
}

// noUncheckedIndexedAccess makes array indexing return T | undefined; this
// asserts the element exists (failing the test with a clear message if not)
// and narrows the type for the caller.
function expectDefined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error('expected value to be defined');
  return value;
}

let sim: AeccSimulator | undefined;
const openClients: Array<{ destroy(): void }> = [];

async function startSim(
  overrides: Partial<SimulatorOptions> = {}
): Promise<AeccSimulator> {
  sim = await AeccSimulator.start({
    scenario: jetSingleUnit as unknown as Scenario,
    port: 0,
    ...overrides,
  });
  return sim;
}

async function connect(port: number): Promise<TestClient> {
  const client = await TestClient.connect(port);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of openClients.splice(0)) client.destroy();
  if (sim) {
    await sim.stop();
    sim = undefined;
  }
});

describe('jet-single-unit fixture integrity', () => {
  it('encodes AcChargingPower in deciwatts and TotalACChargePower in watts, and systemValue reads the watt value', () => {
    const frame = jetSingleUnit.last_poll as unknown as EnergyFrame;
    const storageDeciwatts = frame.Storage_list?.[0]?.AcChargingPower;
    const summaryWatts = frame.SSumInfoList?.TotalACChargePower;

    expect(storageDeciwatts).toBe(7980);
    expect(summaryWatts).toBe(798);
    expect(storageDeciwatts).toBe(Number(summaryWatts) * 10);

    // systemValue must prefer the summary (watt) field, never the raw
    // deciwatt storage field.
    expect(systemValue(frame, 'ac_charging_power')).toBe(798);
    expect(systemValue(frame, 'ac_charging_power')).not.toBe(7980);
  });
});

describe('request/response framing', () => {
  it('answers a newline-terminated request with a response carrying no trailing newline', async () => {
    const running = await startSim();
    const client = await connect(running.port);
    let raw = '';
    client.socket.on('data', chunk => (raw += chunk.toString('utf-8')));

    const response = await client.request(buildGet('EnergyParameter', 1));

    expect(response).toMatchObject({
      Response: 'EnergyParameter',
      SerialNumber: 1,
    });
    expect(raw.endsWith('\n')).toBe(false);
  });

  it('reassembles a response split across several socket.write calls into one parsed object', async () => {
    const running = await startSim({ splitResponseInto: 3 });
    const client = await connect(running.port);

    const response = (await client.request(
      buildGet('EnergyParameter', 7)
    )) as Record<string, unknown>;

    expect(response.Response).toBe('EnergyParameter');
    expect(response.SerialNumber).toBe(7);
    expect(response.Storage_list).toBeDefined();
    expect(response.SSumInfoList).toBeDefined();
  });
});

describe('register reads and writes', () => {
  it('echoes SerialNumber and uses CommandSource as Target', async () => {
    const running = await startSim();
    const client = await connect(running.port);

    const response = (await client.request(
      buildGet('EnergyParameter', 42, { CommandSource: 'TestClient' })
    )) as Record<string, unknown>;

    expect(response.SerialNumber).toBe(42);
    expect(response.Target).toBe('TestClient');
  });

  it('a Set mutates registers and the following Get reflects it', async () => {
    const running = await startSim();
    const client = await connect(running.port);

    const ack = await client.request(
      buildSet('Energycontrolparameters', 1, {
        SetControlInfo: { '3023': '15' },
      })
    );
    expect(ack).not.toBeNull();
    expect(running.registers.get('3023')).toBe('15');

    const getResponse = (await client.request(
      buildGet('Energycontrolparameters', 2, { RegControlAddr: [3023] })
    )) as { ControlInfo: Record<string, string> };
    expect(getResponse.ControlInfo).toEqual({ '3023': '15' });
  });

  it('Get Energycontrolparameters returns only the requested registers', async () => {
    const running = await startSim();
    const client = await connect(running.port);

    const response = (await client.request(
      buildGet('Energycontrolparameters', 1, { RegControlAddr: [3000, 3039] })
    )) as { ControlInfo: Record<string, string> };

    expect(Object.keys(response.ControlInfo).sort()).toEqual(['3000', '3039']);
    expect(response.ControlInfo['3039']).toBe('2400');
  });

  it('dropWriteRate: 1 produces no response at all to a Set', async () => {
    const running = await startSim({ dropWriteRate: 1 });
    const client = await connect(running.port);

    client.send(
      buildSet('Energycontrolparameters', 1, {
        SetControlInfo: { '3000': '0' },
      })
    );
    await expectNoResponse(client);

    // The write is still applied; only the acknowledgement is dropped.
    expect(running.registers.get('3000')).toBe('0');
  });
});

describe('Lunergy shape (omitStorageList)', () => {
  it('produces a frame with no Storage_list but a usable SSumInfoList', async () => {
    const running = await startSim({ omitStorageList: true });
    const client = await connect(running.port);

    const response = (await client.request(
      buildGet('EnergyParameter', 1)
    )) as Record<string, unknown>;

    expect(response.Storage_list).toBeUndefined();
    expect(response.SSumInfoList).toBeDefined();
    expect(
      systemValue(response as EnergyFrame, 'ac_charging_power')
    ).toBeTypeOf('number');
  });
});

describe('DeviceManagement', () => {
  it('deviceManagementTimeout: true never answers a DeviceManagement request', async () => {
    const running = await startSim({ deviceManagementTimeout: true });
    const client = await connect(running.port);

    client.send(
      buildGet('DeviceManagement', 1, { RegDeviceManagementAddr: [20, 21] })
    );
    await expectNoResponse(client);
  });

  it('never serves registers 56 or 57 even when present in the register map', async () => {
    const running = await startSim();
    // Seed the credential registers directly to prove the whitelist, not
    // fixture absence, is what keeps them out of the response.
    running.registers.set('56', 'MyHomeWifi');
    running.registers.set('57', 'hunter2');
    const client = await connect(running.port);

    const response = (await client.request(
      buildGet('DeviceManagement', 1, { RegDeviceManagementAddr: [20, 56, 57] })
    )) as { ControlInfo: Record<string, string> };

    expect(response.ControlInfo['20']).toBe('GTSW0000');
    expect(response.ControlInfo).not.toHaveProperty('56');
    expect(response.ControlInfo).not.toHaveProperty('57');
  });

  it('serves the safe identity registers', async () => {
    const running = await startSim();
    const client = await connect(running.port);

    const response = (await client.request(
      buildGet('DeviceManagement', 1, {
        RegDeviceManagementAddr: [8, 20, 21, 76],
      })
    )) as { ControlInfo: Record<string, string> };

    expect(response.ControlInfo).toEqual({
      '8': 'SIMSN0000000001',
      '20': 'GTSW0000',
      '21': '1.4.9.9.9.1.5',
      '76': '-30',
    });
  });
});

describe('single-session enforcement', () => {
  it('destroys a second concurrent connection while the first stays usable', async () => {
    const running = await startSim();
    const first = await connect(running.port);

    const second = net.createConnection({
      port: running.port,
      host: '127.0.0.1',
    });
    openClients.push(second);
    const secondClosed = new Promise<void>(resolve => {
      second.on('close', () => resolve());
      second.on('error', () => {
        // ECONNRESET from the forced destroy is expected here.
      });
    });
    await secondClosed;
    expect(second.destroyed).toBe(true);

    const response = await first.request(buildGet('EnergyParameter', 1));
    expect(response).toMatchObject({ Response: 'EnergyParameter' });
  });

  it('allows a second connection once refuseSecondConnection is false', async () => {
    const running = await startSim({ refuseSecondConnection: false });
    await connect(running.port);
    const second = await connect(running.port);

    const response = await second.request(buildGet('EnergyParameter', 1));
    expect(response).toMatchObject({ Response: 'EnergyParameter' });
  });
});

describe('setSoc / setPower / injectRawFrame', () => {
  it('setSoc updates BatterySoc and AverageBatteryAverageSOC together', async () => {
    const running = await startSim();
    running.setSoc(77);
    const client = await connect(running.port);

    const response = (await client.request(buildGet('EnergyParameter', 1))) as {
      Storage_list: Array<{ BatterySoc: number }>;
      SSumInfoList: { AverageBatteryAverageSOC: number };
    };

    expect(expectDefined(response.Storage_list[0]).BatterySoc).toBe(77);
    expect(response.SSumInfoList.AverageBatteryAverageSOC).toBe(77);
  });

  it('setPower keeps Storage_list and SSumInfoList consistent through systemValue when charging', async () => {
    const running = await startSim();
    running.setPower(1200);
    const client = await connect(running.port);

    const response = (await client.request(
      buildGet('EnergyParameter', 1)
    )) as EnergyFrame & Record<string, unknown>;

    expect(systemValue(response, 'ac_charging_power')).toBe(1200);
    const storageList = response.Storage_list as Array<Record<string, number>>;
    expect(expectDefined(storageList[0]).AcChargingPower).toBe(12000);
    expect(
      (response.SSumInfoList as Record<string, number>).TotalACChargePower
    ).toBe(1200);
  });

  it('setPower keeps Storage_list and SSumInfoList consistent through systemValue when discharging', async () => {
    const running = await startSim();
    running.setPower(-500);
    const client = await connect(running.port);

    const response = (await client.request(
      buildGet('EnergyParameter', 1)
    )) as EnergyFrame & Record<string, unknown>;

    expect(systemValue(response, 'battery_discharging_power')).toBe(500);
    expect(systemValue(response, 'ac_charging_power')).toBe(0);
    const storageList = response.Storage_list as Array<Record<string, number>>;
    expect(expectDefined(storageList[0]).BatteryDischargingPower).toBe(5000);
    expect(
      (response.SSumInfoList as Record<string, number>).TotalBatteryOutputPower
    ).toBe(500);
  });

  it('injectRawFrame overrides exactly the next poll, then reverts', async () => {
    const running = await startSim();
    running.injectRawFrame({ Storage_list: [] });
    const client = await connect(running.port);

    const injected = (await client.request(
      buildGet('EnergyParameter', 1)
    )) as Record<string, unknown>;
    expect(injected.Storage_list).toEqual([]);

    const normal = (await client.request(
      buildGet('EnergyParameter', 2)
    )) as Record<string, unknown>;
    expect((normal.Storage_list as unknown[]).length).toBeGreaterThan(0);
  });
});

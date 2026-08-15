import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AeccClient } from './client';
import type { SocketFactory, SocketLike } from './connection';

// Auto-connects and auto-closes via real fake-timer setTimeout(0) calls
// rather than queueMicrotask, so vi.advanceTimersByTimeAsync can drive them.
class FakeSocket extends EventEmitter implements SocketLike {
  destroyed = false;
  writes: Buffer[] = [];

  write(data: string | Buffer, callback?: (err?: Error) => void): boolean {
    this.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    callback?.();
    return true;
  }

  end(callback?: () => void): void {
    callback?.();
    this.destroyed = true;
    this.emit('close');
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }

  connect(): void {
    this.emit('connect');
  }

  reply(body: unknown): void {
    this.emit('data', Buffer.from(JSON.stringify(body)));
  }

  replySplit(body: unknown, parts: number): void {
    const json = JSON.stringify(body);
    const size = Math.ceil(json.length / parts);
    for (let i = 0; i < json.length; i += size) {
      this.emit('data', Buffer.from(json.slice(i, i + size)));
    }
  }

  lastRequest(): Record<string, unknown> {
    const raw = this.writes[this.writes.length - 1];
    if (!raw) throw new Error('no request written');
    return JSON.parse(raw.toString('utf-8').trimEnd()) as Record<
      string,
      unknown
    >;
  }
}

function autoConnectFactory(sockets: FakeSocket[]): SocketFactory {
  let i = 0;
  return () => {
    const socket = sockets[i];
    i += 1;
    if (!socket) throw new Error('factory ran out of fake sockets');
    setTimeout(() => socket.connect(), 0);
    return socket;
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AeccClient basic requests', () => {
  it('sends EnergyParameter and resolves the parsed response', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getEnergyParameters();
    await flush();
    expect(socket.writes.length).toBe(1);
    expect(socket.lastRequest()).toMatchObject({
      Get: 'EnergyParameter',
      SerialNumber: 1,
      CommandSource: 'Homey',
    });
    socket.reply({ Response: 'EnergyParameter', SerialNumber: 1 });

    const result = await pending;
    expect(result).toEqual({ Response: 'EnergyParameter', SerialNumber: 1 });
  });

  it('increments SerialNumber across requests', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const p1 = client.getEnergyParameters();
    await flush();
    socket.reply({ SerialNumber: 1 });
    await p1;

    const p2 = client.getEnergyParameters();
    await flush();
    expect(socket.lastRequest().SerialNumber).toBe(2);
    socket.reply({ SerialNumber: 2 });
    await p2;
  });

  it('reassembles a response split across multiple data events', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getEnergyParameters();
    await flush();
    socket.replySplit({ Storage_list: [], SSumInfoList: { a: 1 } }, 3);

    const result = await pending;
    expect(result).toEqual({ Storage_list: [], SSumInfoList: { a: 1 } });
  });

  it('serialises requests one at a time (one in-flight)', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const p1 = client.getEnergyParameters();
    const p2 = client.getEnergyParameters();
    await flush();
    // The second request must not have been written yet.
    expect(socket.writes.length).toBe(1);

    socket.reply({ SerialNumber: 1 });
    await p1;
    await flush();
    expect(socket.writes.length).toBe(2);
    socket.reply({ SerialNumber: 2 });
    await p2;
  });

  it('getControlParameters sends RegControlAddr', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getControlParameters([3000, 3039]);
    await flush();
    expect(socket.lastRequest()).toMatchObject({
      Get: 'Energycontrolparameters',
      RegControlAddr: [3000, 3039],
    });
    socket.reply({ ControlInfo: { '3000': '1', '3039': '2400' } });
    expect(await pending).toEqual({
      ControlInfo: { '3000': '1', '3039': '2400' },
    });
  });

  it('setControlParameters sends SetControlInfo', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.setControlParameters({ '3023': '15' });
    await flush();
    expect(socket.lastRequest()).toMatchObject({
      Set: 'Energycontrolparameters',
      SetControlInfo: { '3023': '15' },
    });
    socket.reply({ ControlState: 'success' });
    expect(await pending).toEqual({ ControlState: 'success' });
  });

  it('resolves null when the response is not a JSON object', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getEnergyParameters();
    await flush();
    socket.reply([1, 2, 3]);

    expect(await pending).toBeNull();
    expect(client.consecutiveFailures).toBe(0);
  });
});

describe('AeccClient.getDeviceIdentity', () => {
  it('requests only the safe register list', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getDeviceIdentity();
    await flush();
    const req = socket.lastRequest();
    expect(req.Get).toBe('DeviceManagement');
    expect(req.RegDeviceManagementAddr).toEqual([2, 8, 9, 20, 21, 76]);

    socket.reply({
      ControlInfo: { '8': ' SN1 ', '20': 'MODEL', '21': '1.2.3', '76': '-40' },
    });
    expect(await pending).toEqual({
      serial: 'SN1',
      model: 'MODEL',
      firmware: '1.2.3',
      rssi: -40,
    });
  });

  it('parses identity from the DeviceManagementInfo container', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getDeviceIdentity();
    await flush();
    socket.reply({
      DeviceManagementInfo: { '8': 'SN2', '20': '', '21': '', '76': '' },
    });
    expect(await pending).toEqual({
      serial: 'SN2',
      model: undefined,
      firmware: undefined,
      rssi: undefined,
    });
  });

  it('returns null when the container is missing', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getDeviceIdentity();
    await flush();
    socket.reply({ Response: 'DeviceManagement' });
    expect(await pending).toBeNull();
  });

  it('never includes registers 56 or 57 in the request', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getDeviceIdentity();
    await flush();
    const req = socket.lastRequest().RegDeviceManagementAddr as number[];
    expect(req).not.toContain(56);
    expect(req).not.toContain(57);
    socket.reply({ ControlInfo: {} });
    await pending;
  });
});

describe('AeccClient read timeout handling', () => {
  it('resolves null on a read timeout without touching the backoff', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      readTimeoutMs: 100,
      socketFactory: autoConnectFactory([socket]),
    });

    const pending = client.getEnergyParameters();
    await flush();
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toBeNull();
    expect(client.consecutiveFailures).toBe(0);
  });

  it('recycles the socket after 3 consecutive read timeouts', async () => {
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      readTimeoutMs: 100,
      socketFactory: autoConnectFactory([s1, s2]),
    });

    for (let i = 0; i < 3; i += 1) {
      const pending = client.getEnergyParameters();
      await flush();
      expect(s1.writes.length).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBeNull();
    }

    // The recycled socket forces a fresh dial on the next request.
    const pending = client.getEnergyParameters();
    await flush();
    expect(s2.writes.length).toBe(1);
    s2.reply({ ok: true });
    expect(await pending).toEqual({ ok: true });
  });

  it('resets the read timeout streak after a successful read', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      readTimeoutMs: 100,
      socketFactory: autoConnectFactory([socket, socket]),
    });

    const p1 = client.getEnergyParameters();
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(await p1).toBeNull();

    const p2 = client.getEnergyParameters();
    await flush();
    socket.reply({ ok: true });
    expect(await p2).toEqual({ ok: true });

    // Two more timeouts (not 3) must not recycle the socket, proving the
    // streak reset after the successful read above.
    for (let i = 0; i < 2; i += 1) {
      const pending = client.getEnergyParameters();
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBeNull();
    }
    expect(socket.destroyed).toBe(false);
  });
});

describe('AeccClient connection error handling', () => {
  it('notes a backoff failure and reconnects after the cooldown', async () => {
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      backoffBaseMs: 50,
      socketFactory: autoConnectFactory([s1, s2]),
    });

    const pending = client.getEnergyParameters();
    await flush();
    s1.emit('error', new Error('ECONNRESET'));
    await vi.runAllTimersAsync();

    expect(await pending).toBeNull();
    expect(client.consecutiveFailures).toBe(1);

    // Reconnect already happened as part of the failed call; the next
    // request reuses that fresh socket without dialing a third time.
    const p2 = client.getEnergyParameters();
    await flush();
    expect(s2.writes.length).toBe(1);
    s2.reply({ ok: true });
    expect(await p2).toEqual({ ok: true });
    expect(client.consecutiveFailures).toBe(0);
  });

  it('escalates the cooldown across repeated connection errors', async () => {
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
    const client = new AeccClient({
      host: 'h',
      port: 1,
      backoffBaseMs: 10,
      socketFactory: autoConnectFactory(sockets),
    });

    for (let i = 0; i < 2; i += 1) {
      const socket = sockets[i];
      if (!socket) throw new Error('setup');
      const pending = client.getEnergyParameters();
      await flush();
      expect(socket.writes.length).toBe(1);
      socket.emit('error', new Error('reset'));
      await vi.runAllTimersAsync();
      expect(await pending).toBeNull();
    }
    expect(client.consecutiveFailures).toBe(2);
  });
});

describe('AeccClient.connect / disconnect', () => {
  it('connect() notes a backoff success', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });
    const pending = client.connect();
    await flush();
    await pending;
    expect(client.consecutiveFailures).toBe(0);
  });

  it('connect() propagates a dial failure', async () => {
    const factory: SocketFactory = () => {
      const socket = new FakeSocket();
      setTimeout(() => socket.emit('error', new Error('refused')), 0);
      return socket;
    };
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: factory,
    });
    const pending = client.connect();
    const assertion = expect(pending).rejects.toThrow('refused');
    await flush();
    await assertion;
  });

  it('disconnect() closes the underlying socket', async () => {
    const socket = new FakeSocket();
    const client = new AeccClient({
      host: 'h',
      port: 1,
      socketFactory: autoConnectFactory([socket]),
    });
    const connectPending = client.connect();
    await flush();
    await connectPending;

    const closePromise = client.disconnect();
    await flush();
    await closePromise;
    expect(socket.destroyed).toBe(true);
  });
});

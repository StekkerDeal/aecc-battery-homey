import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AeccSession,
  systemScheduler,
  type AeccSessionOptions,
  type SessionEvent,
} from './session';
import type { SocketFactory, SocketLike } from './transport/connection';

type Hook = (
  req: Record<string, unknown>
) => 'respond' | 'drop' | 'silent' | undefined;

// Minimal in-process stand-in for the AECC wire protocol: enough to drive
// AeccSession through AeccClient/AeccConnection without a real socket, so
// tests can use fake timers safely (no real I/O to race against).
class FakeDeviceSocket extends EventEmitter implements SocketLike {
  destroyed = false;
  registers = new Map<string, string>([
    ['3000', '1'],
    ['3003', '0,00:00,00:00,0,0,0,0,0,0,100,10'],
    ['3020', '3'],
    ['3021', '1'],
    ['3022', '1'],
    ['3023', '10'],
    ['3024', '100'],
    ['3030', '0'],
  ]);
  frame: Record<string, unknown> = {
    Storage_list: [
      {
        DevAddr: 1,
        StorageSN: 'SN1',
        BatterySoc: 50,
        AcChargingPower: 0,
        BatteryDischargingPower: 0,
        AcInActivePower: 0,
      },
    ],
    SSumInfoList: {
      AverageBatteryAverageSOC: 50,
      TotalACChargePower: 0,
      TotalBatteryOutputPower: 0,
    },
  };
  responseDelayMs = 0;
  hook: Hook | null = null;
  requests: Record<string, unknown>[] = [];

  write(
    data: string | Buffer,
    callback?: (err?: Error | null) => void
  ): boolean {
    callback?.();
    const text = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
    const req = JSON.parse(text.trimEnd()) as Record<string, unknown>;
    this.requests.push(req);
    this.handle(req);
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
    this.destroyed = false;
    this.emit('connect');
  }

  private handle(req: Record<string, unknown>): void {
    const serial = req.SerialNumber;
    const target = req.CommandSource;
    const mode = this.hook?.(req) ?? 'respond';

    if (req.Get === 'EnergyParameter') {
      if (mode === 'silent') return;
      this.reply({
        Response: 'EnergyParameter',
        SerialNumber: serial,
        Target: target,
        ...this.frame,
      });
      return;
    }
    if (req.Get === 'Energycontrolparameters') {
      if (mode === 'silent') return;
      const addrs = (req.RegControlAddr as number[] | undefined) ?? [];
      const info: Record<string, string> = {};
      for (const a of addrs) {
        const v = this.registers.get(String(a));
        if (v !== undefined) info[String(a)] = v;
      }
      this.reply({
        Response: 'Energycontrolparameters',
        SerialNumber: serial,
        Target: target,
        ControlInfo: info,
      });
      return;
    }
    if (req.Set === 'Energycontrolparameters') {
      const values =
        (req.SetControlInfo as Record<string, unknown> | undefined) ?? {};
      for (const [k, v] of Object.entries(values)) {
        this.registers.set(k, String(v));
      }
      if (mode === 'drop' || mode === 'silent') return;
      this.reply({
        Response: 'Energycontrolparameters',
        SerialNumber: serial,
        Target: target,
        ControlState: 'success',
      });
      return;
    }
    if (req.Get === 'DeviceManagement') {
      if (mode === 'silent') return;
      const addrs = (req.RegDeviceManagementAddr as number[] | undefined) ?? [];
      const info: Record<string, string> = {};
      for (const a of addrs) {
        if (a === 56 || a === 57) continue;
        const v = this.registers.get(String(a));
        if (v !== undefined) info[String(a)] = v;
      }
      this.reply({
        Response: 'DeviceManagement',
        SerialNumber: serial,
        Target: target,
        ControlInfo: info,
      });
    }
  }

  private reply(body: unknown): void {
    setTimeout(() => {
      if (!this.destroyed) {
        this.emit('data', Buffer.from(JSON.stringify(body)));
      }
    }, this.responseDelayMs);
  }
}

function factoryFor(socket: FakeDeviceSocket): SocketFactory {
  return () => {
    setTimeout(() => socket.connect(), 0);
    return socket;
  };
}

const sessions: AeccSession[] = [];

function makeSession(overrides: Partial<AeccSessionOptions> = {}): {
  session: AeccSession;
  socket: FakeDeviceSocket;
} {
  const socket = new FakeDeviceSocket();
  const session = new AeccSession({
    host: '127.0.0.1',
    port: 1,
    brand: 'jet',
    limits: { maxChargeW: 800, maxDischargeW: 800 },
    scheduler: systemScheduler,
    pollIntervalMs: 2000,
    verifyIntervalMs: 0,
    startDelayMs: 0,
    connectTimeoutMs: 200,
    readTimeoutMs: 200,
    deviceManagementTimeoutMs: 200,
    backoffBaseMs: 50,
    backoffMaxMs: 400,
    closeGraceMs: 10,
    socketFactory: factoryFor(socket),
    ...overrides,
  });
  sessions.push(session);
  return { session, socket };
}

async function settle(): Promise<void> {
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const session of sessions.splice(0)) {
    vi.useFakeTimers();
    await session.stop();
    vi.useRealTimers();
  }
});

describe('AeccSession snapshot / subscribe', () => {
  it('starts with sane defaults before any poll', () => {
    const { session } = makeSession();
    const snap = session.snapshot;
    expect(snap.telemetry).toBeNull();
    expect(snap.identity).toBeNull();
    expect(snap.workMode).toBeNull();
    expect(snap.commandedTargetPowerW).toBe(0);
    expect(snap.minSoc).toBe(10);
    expect(snap.maxSoc).toBe(100);
    expect(snap.hasStorageList).toBe(false);
    expect(snap.available).toBe(true);
  });

  it('delivers events to subscribers and stops after unsubscribe', async () => {
    const { session } = makeSession();
    const events: SessionEvent[] = [];
    const unsubscribe = session.subscribe(e => events.push(e));

    const pending = session.setMinSoc(20);
    await settle();
    await pending;
    expect(events.some(e => e.type === 'write')).toBe(true);
    expect(events.some(e => e.type === 'snapshot')).toBe(true);

    unsubscribe();
    events.length = 0;
    const pending2 = session.setMinSoc(30);
    await settle();
    await pending2;
    expect(events.length).toBe(0);
  });
});

describe('AeccSession.readInitialState', () => {
  it('parses min/max soc, decoded slot direction and work mode', async () => {
    const { session, socket } = makeSession();
    socket.registers.set('3023', '15');
    socket.registers.set('3024', '90');
    socket.registers.set('3021', '0');
    socket.registers.set('3022', '0');
    socket.registers.set('3003', '1,00:00,23:59,-400,0,6,5,0,0,90,15');

    const pending = session.readInitialState();
    await settle();
    await pending;

    const snap = session.snapshot;
    expect(snap.minSoc).toBe(15);
    expect(snap.maxSoc).toBe(90);
    expect(snap.commandedTargetPowerW).toBe(400);
    expect(snap.workMode).toBe('custom');
  });

  it('reads a discharge slot as a negative commanded power', async () => {
    const { session, socket } = makeSession();
    socket.registers.set('3003', '1,00:00,23:59,300,0,6,5,0,0,90,15');

    const pending = session.readInitialState();
    await settle();
    await pending;

    expect(session.snapshot.commandedTargetPowerW).toBe(-300);
  });

  it('reports self_consumption when AI smart charge/discharge is on', async () => {
    const { session, socket } = makeSession();
    socket.registers.set('3021', '1');
    socket.registers.set('3022', '1');

    const pending = session.readInitialState();
    await settle();
    await pending;

    expect(session.snapshot.workMode).toBe('self_consumption');
  });

  it('leaves state untouched when the device never responds', async () => {
    const { session, socket } = makeSession();
    socket.hook = () => 'silent';

    const pending = session.readInitialState();
    await settle();
    await pending;

    expect(session.snapshot.workMode).toBeNull();
  });
});

describe('AeccSession.probeIdentity', () => {
  it('populates identity from the safe register set', async () => {
    const { session, socket } = makeSession();
    socket.registers.set('8', 'SN1');
    socket.registers.set('20', 'MODEL');
    socket.registers.set('21', '1.0');
    socket.registers.set('76', '-40');

    const pending = session.probeIdentity();
    await settle();
    await pending;

    expect(session.snapshot.identity).toEqual({
      serial: 'SN1',
      model: 'MODEL',
      firmware: '1.0',
      rssi: -40,
    });
  });
});

describe('AeccSession setters', () => {
  it('setTargetPower writes a charge slot and marks work mode custom', async () => {
    const { session, socket } = makeSession();
    const pending = session.setTargetPower(400);
    await settle();
    const ok = await pending;

    expect(ok).toBe(true);
    expect(session.snapshot.workMode).toBe('custom');
    expect(session.snapshot.commandedTargetPowerW).toBe(400);
    // No poll has run yet, so hasStorageList is still false (field7=4).
    expect(socket.registers.get('3003')).toBe(
      '1,00:00,23:59,-400,0,6,4,0,0,100,10'
    );
  });

  it('setWorkMode(self_consumption) clears register 3003', async () => {
    const { session, socket } = makeSession();
    const setPending = session.setTargetPower(400);
    await settle();
    await setPending;

    const pending = session.setWorkMode('self_consumption');
    await settle();
    const ok = await pending;

    expect(ok).toBe(true);
    expect(session.snapshot.workMode).toBe('self_consumption');
    expect(socket.registers.get('3003')).toBe(
      '0,00:00,00:00,0,0,0,0,0,0,100,10'
    );
  });

  it('setWorkMode(custom) re-applies the last commanded setpoint', async () => {
    const { session, socket } = makeSession();
    const setPending = session.setTargetPower(400);
    await settle();
    await setPending;

    // Simulate the vendor app (or self_consumption) having cleared the slot.
    socket.registers.set('3003', '0,00:00,00:00,0,0,0,0,0,0,100,10');

    const events: SessionEvent[] = [];
    session.subscribe(e => events.push(e));
    const pending = session.setWorkMode('custom');
    await settle();
    const ok = await pending;

    expect(ok).toBe(true);
    expect(socket.registers.get('3003')).toBe(
      '1,00:00,23:59,-400,0,6,4,0,0,100,10'
    );
    const writeOps = events
      .filter(
        (e): e is Extract<SessionEvent, { type: 'write' }> => e.type === 'write'
      )
      .map(e => e.operation);
    expect(writeOps).toEqual([
      'work_mode(custom)',
      'battery_control(charge, 400W)',
    ]);
  });

  it('setMinSoc and setMaxSoc write their registers', async () => {
    const { session, socket } = makeSession();
    const p1 = session.setMinSoc(15);
    await settle();
    await p1;
    const p2 = session.setMaxSoc(95);
    await settle();
    await p2;

    expect(socket.registers.get('3023')).toBe('15');
    expect(socket.registers.get('3024')).toBe('95');
    expect(session.snapshot.minSoc).toBe(15);
    expect(session.snapshot.maxSoc).toBe(95);
  });

  it('reapplySetpoint clamps to the configured limit', async () => {
    const { session, socket } = makeSession({
      limits: { maxChargeW: 500, maxDischargeW: 500 },
    });
    const p1 = session.setTargetPower(800);
    await settle();
    await p1;

    expect(socket.registers.get('3003')).toBe(
      '1,00:00,23:59,-500,0,6,4,0,0,100,10'
    );
  });
});

describe('AeccSession write retry / failure', () => {
  it('records a write event with the compareVerify result on success', async () => {
    const { session } = makeSession();
    const events: SessionEvent[] = [];
    session.subscribe(e => events.push(e));

    const pending = session.setMinSoc(20);
    await settle();
    await pending;

    const writeEvent = events.find(
      (e): e is Extract<SessionEvent, { type: 'write' }> => e.type === 'write'
    );
    expect(writeEvent).toBeDefined();
    expect(writeEvent?.ok).toBe(true);
    expect(writeEvent?.attempts).toBe(1);
    expect(writeEvent?.verify).not.toBeNull();
    expect(session.writeHistory).toHaveLength(1);
    expect(session.writeHistory[0]?.operation).toBe('min_soc(20%)');
  });

  it('succeeds on retry after one dropped ack', async () => {
    const { session, socket } = makeSession();
    let drops = 1;
    socket.hook = req => {
      if (req.Set === 'Energycontrolparameters' && drops > 0) {
        drops -= 1;
        return 'drop';
      }
      return 'respond';
    };

    const pending = session.setMinSoc(25);
    await settle();
    const ok = await pending;

    expect(ok).toBe(true);
    expect(session.writeHistory[0]?.attempts).toBe(2);
  });

  it('reports ok:false after exhausting all retry attempts', async () => {
    const { session, socket } = makeSession();
    socket.hook = req =>
      req.Set === 'Energycontrolparameters' ? 'drop' : 'respond';

    const pending = session.setMinSoc(25);
    await settle();
    const ok = await pending;

    expect(ok).toBe(false);
    expect(session.writeHistory[0]?.attempts).toBe(3);
    expect(session.writeHistory[0]?.verify).toBeNull();
  });

  it('keeps only the last 20 write history entries', async () => {
    const { session } = makeSession();
    for (let i = 0; i < 22; i += 1) {
      const pending = session.setMinSoc(i);
      await settle();
      await pending;
    }
    expect(session.writeHistory).toHaveLength(20);
    expect(session.writeHistory[19]?.operation).toBe('min_soc(21%)');
  });
});

describe('AeccSession.updateOptions', () => {
  it('clamps a live pollIntervalMs update to the 2000ms floor', async () => {
    const { session, socket } = makeSession({ pollIntervalMs: 2000 });
    session.updateOptions({ pollIntervalMs: 200 });

    const startPending = session.start();
    // A small advance is enough for start() to resolve: poll #1, then the
    // initial-state and identity reads, all zero-delay in this fake device.
    await vi.advanceTimersByTimeAsync(50);
    await startPending;

    const countAfterStart = socket.requests.filter(
      r => r.Get === 'EnergyParameter'
    ).length;
    expect(countAfterStart).toBe(1);

    await vi.advanceTimersByTimeAsync(1500);
    expect(
      socket.requests.filter(r => r.Get === 'EnergyParameter').length
    ).toBe(1);

    await vi.advanceTimersByTimeAsync(700);
    expect(
      socket.requests.filter(r => r.Get === 'EnergyParameter').length
    ).toBeGreaterThanOrEqual(2);
  });

  it('applies updated limits to the next reapplySetpoint', async () => {
    const { session, socket } = makeSession({
      limits: { maxChargeW: 800, maxDischargeW: 800 },
    });
    const p1 = session.setTargetPower(700);
    await settle();
    await p1;

    session.updateOptions({ limits: { maxChargeW: 300, maxDischargeW: 300 } });
    const p2 = session.reapplySetpoint();
    await settle();
    await p2;

    expect(socket.registers.get('3003')).toBe(
      '1,00:00,23:59,-300,0,6,4,0,0,100,10'
    );
  });
});

describe('AeccSession lifecycle and failure tolerance', () => {
  it('start() populates a first snapshot and stop() disconnects', async () => {
    const { session, socket } = makeSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    expect(session.snapshot.telemetry?.socPct).toBe(50);
    expect(session.snapshot.available).toBe(true);

    await session.stop();
    expect(socket.destroyed).toBe(true);
  });

  it('emits unavailable exactly once after 5 consecutive failed polls, and available once on recovery', async () => {
    const { session, socket } = makeSession({
      pollIntervalMs: 2000,
      readTimeoutMs: 100,
    });
    const events: SessionEvent[] = [];
    session.subscribe(e => events.push(e));

    const startPending = session.start();
    await vi.advanceTimersByTimeAsync(2000);
    await startPending;

    socket.hook = req => (req.Get === 'EnergyParameter' ? 'silent' : 'respond');
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(2600);
    }

    const unavailableCount = events.filter(
      e => e.type === 'unavailable'
    ).length;
    expect(unavailableCount).toBe(1);
    expect(session.snapshot.available).toBe(false);

    socket.hook = null;
    await vi.advanceTimersByTimeAsync(2600);

    const availableCount = events.filter(e => e.type === 'available').length;
    expect(availableCount).toBe(1);
    expect(session.snapshot.available).toBe(true);

    await session.stop();
  });
});

// A glitched SOC sample must not flicker the capability to unknown: the
// brand profile's holdLastValueSeconds is how long the last accepted value
// stands in for it. The JET profile holds 120s.
describe('AeccSession SOC hold window', () => {
  // SOC 0 while the wall side shows active flow above the brand threshold is
  // the rejection the Lunergy lockups motivated.
  function glitchSoc(socket: FakeDeviceSocket): void {
    socket.frame = {
      Storage_list: [
        {
          DevAddr: 1,
          StorageSN: 'SN1',
          BatterySoc: 0,
          AcChargingPower: 8000,
          BatteryDischargingPower: 0,
          AcInActivePower: 0,
        },
      ],
      SSumInfoList: {
        AverageBatteryAverageSOC: 0,
        TotalACChargePower: 800,
        TotalBatteryOutputPower: 0,
      },
    };
  }

  it('holds the last accepted SOC while a rejected sample is inside the window', async () => {
    const { session, socket } = makeSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(session.snapshot.telemetry?.socPct).toBe(50);

    glitchSoc(socket);
    await vi.advanceTimersByTimeAsync(2600);

    expect(session.snapshot.telemetry?.socPct).toBe(50);
    await session.stop();
  });

  it('gives up and reports unknown once the hold window has expired', async () => {
    const { session, socket } = makeSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    glitchSoc(socket);
    // Well past the 120s profile window, so the held value is stale enough
    // that unknown is the honest answer.
    await vi.advanceTimersByTimeAsync(130_000);

    expect(session.snapshot.telemetry?.socPct).toBeNull();
    await session.stop();
  });

  it('does not advance the anchor during a hold, so recovery compares against the last trusted value', async () => {
    const { session, socket } = makeSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    glitchSoc(socket);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.snapshot.telemetry?.socPct).toBe(50);

    // 5% about 63s after the last real sample is roughly 4.8%/min, inside the
    // JET's 10%/min limit, so it is accepted. Had the hold advanced the anchor
    // to each glitch poll, the same step would measure from 2.6s ago at about
    // 115%/min and be rejected, leaving 50 here.
    socket.frame = {
      Storage_list: [
        {
          DevAddr: 1,
          StorageSN: 'SN1',
          BatterySoc: 55,
          AcChargingPower: 0,
          BatteryDischargingPower: 0,
          AcInActivePower: 0,
        },
      ],
      SSumInfoList: {
        AverageBatteryAverageSOC: 55,
        TotalACChargePower: 0,
        TotalBatteryOutputPower: 0,
      },
    };
    await vi.advanceTimersByTimeAsync(2600);

    expect(session.snapshot.telemetry?.socPct).toBe(55);
    await session.stop();
  });
});

describe('AeccSession drift check', () => {
  it('re-applies the commanded setpoint when the device slot has drifted', async () => {
    const { session, socket } = makeSession({
      verifyIntervalMs: 2000,
      pollIntervalMs: 2000,
    });
    const setPending = session.setTargetPower(400);
    await settle();
    await setPending;
    expect(socket.registers.get('3003')).toBe(
      '1,00:00,23:59,-400,0,6,4,0,0,100,10'
    );

    // The vendor app (or a dropped write) changed the slot underneath us.
    socket.registers.set('3003', '0,00:00,00:00,0,0,0,0,0,0,100,10');

    const events: SessionEvent[] = [];
    session.subscribe(e => events.push(e));
    const startPending = session.start();
    await vi.advanceTimersByTimeAsync(4000);
    await startPending;

    expect(socket.registers.get('3003')).toBe(
      '1,00:00,23:59,-400,0,6,5,0,0,100,10'
    );
    expect(
      events.some(
        e =>
          e.type === 'write' && e.operation === 'battery_control(charge, 400W)'
      )
    ).toBe(true);

    await session.stop();
  });

  it('does nothing when verifyIntervalMs is 0', async () => {
    const { session, socket } = makeSession({
      verifyIntervalMs: 0,
      pollIntervalMs: 2000,
    });
    const setPending = session.setTargetPower(400);
    await settle();
    await setPending;
    socket.registers.set('3003', '0,00:00,00:00,0,0,0,0,0,0,100,10');

    const startPending = session.start();
    await vi.advanceTimersByTimeAsync(2000);
    await startPending;

    expect(socket.registers.get('3003')).toBe(
      '0,00:00,00:00,0,0,0,0,0,0,100,10'
    );
    await session.stop();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { AeccSimulator, type Scenario } from '../sim/aecc-simulator';
import {
  AeccSession,
  systemScheduler,
  type SessionEvent,
} from '../../lib/session';
import jetSingleUnit from '../fixtures/jet-single-unit.json';
import { FAST_OPTS, freePort, waitFor } from './helpers';

let sim: AeccSimulator | undefined;
let session: AeccSession | undefined;

afterEach(async () => {
  if (session) {
    await session.stop();
    session = undefined;
  }
  if (sim) {
    await sim.stop();
    sim = undefined;
  }
});

describe('AeccSession full lifecycle', () => {
  it('start populates a first snapshot with sane JET values, stop closes the socket', async () => {
    sim = await AeccSimulator.start({
      scenario: jetSingleUnit as unknown as Scenario,
      port: 0,
    });
    session = new AeccSession({
      host: '127.0.0.1',
      port: sim.port,
      brand: 'jet',
      limits: { maxChargeW: 800, maxDischargeW: 800 },
      scheduler: systemScheduler,
      pollIntervalMs: 2000,
      verifyIntervalMs: 0,
      ...FAST_OPTS,
    });

    await session.start();

    const snap = session.snapshot;
    // JET fixture: BatterySoc 28, TotalACChargePower 798W (charging).
    expect(snap.telemetry?.socPct).toBe(28);
    expect(snap.telemetry?.measurePowerW).toBe(798);
    expect(snap.telemetry?.chargingState).toBe('charging');
    expect(snap.hasStorageList).toBe(true);
    expect(snap.available).toBe(true);
    expect(snap.identity?.serial).toBe('SIMSN0000000001');

    await session.stop();
    const port = sim.port;
    session = undefined;

    // Proves the socket was actually released server-side: a fresh session
    // can connect and poll successfully on the very same port.
    const second = new AeccSession({
      host: '127.0.0.1',
      port,
      brand: 'jet',
      limits: { maxChargeW: 800, maxDischargeW: 800 },
      scheduler: systemScheduler,
      pollIntervalMs: 2000,
      verifyIntervalMs: 0,
      ...FAST_OPTS,
    });
    session = second;
    await second.start();
    expect(second.snapshot.telemetry?.socPct).toBe(28);
  }, 15000);
});

describe('AeccSession failure tolerance', () => {
  it('emits unavailable exactly once after 5 consecutive failed polls, and available once on recovery', async () => {
    const port = await freePort();
    const events: SessionEvent[] = [];
    session = new AeccSession({
      host: '127.0.0.1',
      port,
      brand: 'jet',
      limits: { maxChargeW: 800, maxDischargeW: 800 },
      scheduler: systemScheduler,
      pollIntervalMs: 2000,
      verifyIntervalMs: 0,
      ...FAST_OPTS,
    });
    session.subscribe(e => events.push(e));

    // Nothing is listening on `port` yet: start() and the first several
    // polls all fail with connection-refused.
    void session.start();

    await waitFor(
      () => events.filter(e => e.type === 'unavailable').length === 1,
      20000
    );
    expect(session.snapshot.available).toBe(false);
    expect(events.filter(e => e.type === 'unavailable').length).toBe(1);

    sim = await AeccSimulator.start({
      scenario: jetSingleUnit as unknown as Scenario,
      port,
    });

    await waitFor(
      () => events.filter(e => e.type === 'available').length === 1,
      10000
    );
    expect(session.snapshot.available).toBe(true);
    expect(events.filter(e => e.type === 'available').length).toBe(1);
    expect(events.filter(e => e.type === 'unavailable').length).toBe(1);
  }, 30000);
});

describe('AeccSession mid-poll socket reset', () => {
  it('recovers without ever going unavailable', async () => {
    sim = await AeccSimulator.start({
      scenario: jetSingleUnit as unknown as Scenario,
      port: 0,
      // Every 2nd request gets its connection reset; a poll spans exactly
      // one request, so alternating polls see a reset socket.
      resetEveryNRequests: 2,
    });
    const events: SessionEvent[] = [];
    session = new AeccSession({
      host: '127.0.0.1',
      port: sim.port,
      brand: 'jet',
      limits: { maxChargeW: 800, maxDischargeW: 800 },
      scheduler: systemScheduler,
      pollIntervalMs: 2000,
      verifyIntervalMs: 0,
      ...FAST_OPTS,
    });
    session.subscribe(e => events.push(e));

    await session.start();
    const pollsSeen = (): number =>
      (sim?.requests ?? []).filter(r => {
        const parsed = r.parsed as Record<string, unknown> | null;
        return parsed && parsed.Get === 'EnergyParameter';
      }).length;

    await waitFor(() => pollsSeen() >= 6, 20000);

    expect(events.some(e => e.type === 'unavailable')).toBe(false);
    expect(session.snapshot.available).toBe(true);
    expect(session.snapshot.telemetry?.socPct).toBe(28);
  }, 25000);
});

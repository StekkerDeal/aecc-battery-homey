import { afterEach, describe, expect, it } from 'vitest';
import { AeccSimulator, type Scenario } from '../sim/aecc-simulator';
import {
  AeccSession,
  systemScheduler,
  type SessionEvent,
} from '../../lib/session';
import jetSingleUnit from '../fixtures/jet-single-unit.json';
import { FAST_OPTS, freePort } from './helpers';

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

function makeSession(
  port: number,
  overrides: Record<string, unknown> = {}
): AeccSession {
  const s = new AeccSession({
    host: '127.0.0.1',
    port,
    brand: 'jet',
    limits: { maxChargeW: 800, maxDischargeW: 800 },
    scheduler: systemScheduler,
    pollIntervalMs: 2000,
    verifyIntervalMs: 0,
    ...FAST_OPTS,
    ...overrides,
  });
  session = s;
  return s;
}

describe('AeccSession writes', () => {
  it('a write whose first attempt fails on a dead connection succeeds on retry once the device comes online', async () => {
    const port = await freePort();
    const s = makeSession(port, { backoffBaseMs: 20, backoffMaxMs: 50 });
    const events: SessionEvent[] = [];
    s.subscribe(e => events.push(e));

    const writePromise = s.setMinSoc(42);
    // Bring the device online well inside the fixed 1000ms write-retry
    // delay, so attempt 1 (connection refused) fails and attempt 2 (device
    // now reachable) succeeds.
    await new Promise(resolve => setTimeout(resolve, 150));
    sim = await AeccSimulator.start({
      scenario: jetSingleUnit as unknown as Scenario,
      port,
    });

    const ok = await writePromise;
    expect(ok).toBe(true);

    const writeEvent = events.find(
      (e): e is Extract<SessionEvent, { type: 'write' }> => e.type === 'write'
    );
    expect(writeEvent?.attempts).toBe(2);
    expect(sim.registers.get('3023')).toBe('42');
  }, 10000);

  it('a write dropped on every attempt reports ok:false after 3 attempts', async () => {
    sim = await AeccSimulator.start({
      scenario: jetSingleUnit as unknown as Scenario,
      port: 0,
      dropWriteRate: 1,
    });
    const s = makeSession(sim.port);
    const events: SessionEvent[] = [];
    s.subscribe(e => events.push(e));

    const ok = await s.setMinSoc(33);

    expect(ok).toBe(false);
    const writeEvent = events.find(
      (e): e is Extract<SessionEvent, { type: 'write' }> => e.type === 'write'
    );
    expect(writeEvent?.attempts).toBe(3);
    expect(writeEvent?.ok).toBe(false);
    // The write still lands even though the acknowledgement is dropped.
    expect(sim.registers.get('3023')).toBe('33');
  }, 15000);

  it('with 3+ consecutive client failures, a write is attempted only once', async () => {
    const port = await freePort();
    const s = makeSession(port, { backoffBaseMs: 10, backoffMaxMs: 30 });

    // Drive the client's connection-failure streak to 3+ via plain reads
    // against a port nothing is listening on.
    await s.readInitialState();
    await s.readInitialState();
    await s.readInitialState();

    sim = await AeccSimulator.start({
      scenario: jetSingleUnit as unknown as Scenario,
      port,
      dropWriteRate: 1,
    });

    const events: SessionEvent[] = [];
    s.subscribe(e => events.push(e));
    const ok = await s.setMinSoc(50);

    expect(ok).toBe(false);
    const writeEvent = events.find(
      (e): e is Extract<SessionEvent, { type: 'write' }> => e.type === 'write'
    );
    expect(writeEvent?.attempts).toBe(1);
  }, 15000);
});

import { afterEach, describe, expect, it } from 'vitest';
import { AeccSimulator, type Scenario } from '../sim/aecc-simulator';
import { AeccSession, systemScheduler } from '../../lib/session';
import { SessionRegistry } from '../../lib/session-registry';
import jetSingleUnit from '../fixtures/jet-single-unit.json';
import { FAST_OPTS } from './helpers';

let sim: AeccSimulator | undefined;
let registry: SessionRegistry | undefined;

afterEach(async () => {
  if (registry) {
    await registry.stopAll();
    registry = undefined;
  }
  if (sim) {
    await sim.stop();
    sim = undefined;
  }
});

describe('SessionRegistry against a real device', () => {
  it('shares one session (and one TCP connection) across two acquires; one release does not stop it', async () => {
    sim = await AeccSimulator.start({
      scenario: jetSingleUnit as unknown as Scenario,
      port: 0,
      // Default true, kept explicit: a bug that opened two connections for
      // the two acquires would show up as a refused second socket.
      refuseSecondConnection: true,
    });
    registry = new SessionRegistry();
    const port = sim.port;
    const key = `127.0.0.1:${port}`;
    let built = 0;
    const factory = (): AeccSession => {
      built += 1;
      return new AeccSession({
        host: '127.0.0.1',
        port,
        brand: 'jet',
        limits: { maxChargeW: 800, maxDischargeW: 800 },
        scheduler: systemScheduler,
        pollIntervalMs: 2000,
        verifyIntervalMs: 0,
        ...FAST_OPTS,
      });
    };

    const first = registry.acquire(key, factory);
    const second = registry.acquire(key, factory);

    expect(second.session).toBe(first.session);
    expect(second.index).toBe(first.index);
    expect(built).toBe(1);
    expect(registry.size).toBe(1);

    await first.session.start();
    expect(first.session.snapshot.telemetry?.socPct).toBe(28);

    await registry.release(key);
    // Still referenced once more: the shared session must not have stopped,
    // proven by it still answering a fresh poll.
    expect(registry.size).toBe(1);
    const ok = await first.session.setMinSoc(20);
    expect(ok).toBe(true);

    await registry.release(key);
    expect(registry.size).toBe(0);
  }, 15000);

  it('assigns a distinct, increasing index per host:port for startup stagger', () => {
    registry = new SessionRegistry();
    const a = registry.acquire('127.0.0.1:1', () => fakeSession());
    const b = registry.acquire('127.0.0.1:2', () => fakeSession());
    expect(a.index).toBe(0);
    expect(b.index).toBe(1);
  });
});

function fakeSession(): AeccSession {
  return {
    stop: async () => {
      /* no real connection to close in this synchronous test */
    },
  } as unknown as AeccSession;
}

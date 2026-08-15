import { afterEach, describe, expect, it } from 'vitest';
import { AeccSimulator, type Scenario } from '../sim/aecc-simulator';
import {
  AeccSession,
  systemScheduler,
  type SessionEvent,
} from '../../lib/session';
import jetSingleUnit from '../fixtures/jet-single-unit.json';
import { FAST_OPTS, waitFor } from './helpers';

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

describe('AeccSession drift check', () => {
  it('re-applies a setpoint that the device changed underneath it', async () => {
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
      verifyIntervalMs: 2000,
      ...FAST_OPTS,
    });

    // Establish a commanded custom setpoint (also runs one poll, so
    // hasStorageList becomes true, field7=5, before we start()).
    await session.start();
    const ok = await session.setTargetPower(350);
    expect(ok).toBe(true);
    // readInitialState() picked up the fixture's maxSoc (3024=80) already.
    const expectedSlot = '1,00:00,23:59,-350,0,6,5,0,0,80,10';
    expect(sim.registers.get('3003')).toBe(expectedSlot);

    // The vendor app (or a competing writer) changes the slot underneath us.
    sim.registers.set('3003', '0,00:00,00:00,0,0,0,0,0,0,100,10');

    const events: SessionEvent[] = [];
    session.subscribe(e => events.push(e));

    // Wait for the drift-correction write itself, not just the register: the
    // simulator applies a Set synchronously on receipt, well before the
    // session's own write event fires (which waits out the verify delay).
    await waitFor(
      () =>
        events.some(
          e =>
            e.type === 'write' &&
            e.operation === 'battery_control(charge, 350W)'
        ),
      8000
    );

    expect(sim.registers.get('3003')).toBe(expectedSlot);

    // The drift event carries both values signed in the Homey convention, so
    // the device layer never has to infer a correction from write events.
    const drift = events.filter(e => e.type === 'drift');
    expect(drift).toHaveLength(1);
    expect(drift[0]).toEqual({
      type: 'drift',
      expectedPowerW: 350,
      foundPowerW: 0,
    });
  }, 15000);

  it('stays silent when the setpoint has not drifted', async () => {
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
      verifyIntervalMs: 2000,
      ...FAST_OPTS,
    });

    await session.start();
    expect(await session.setTargetPower(350)).toBe(true);

    const events: SessionEvent[] = [];
    session.subscribe(e => events.push(e));

    // Let at least two drift checks run against an untouched slot.
    await waitFor(
      () => events.filter(e => e.type === 'snapshot').length >= 3,
      8000
    );
    expect(events.filter(e => e.type === 'drift')).toHaveLength(0);
  }, 15000);
});

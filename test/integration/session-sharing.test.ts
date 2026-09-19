import { afterEach, describe, expect, it } from 'vitest';
import { AeccSimulator, type Scenario } from '../sim/aecc-simulator';
import {
  AeccSession,
  systemScheduler,
  type SessionEvent,
  type SessionSnapshot,
} from '../../lib/session';
import { SessionRegistry } from '../../lib/session-registry';
import { sessionOptionsFrom } from '../../lib/homey/session-factory';
import { SessionLease } from '../../lib/homey/session-lease';
import { ProductionIntegrator } from '../../lib/protocol/energy-meter';
import type { AeccDeviceSettings } from '../../lib/homey/device-settings';
import jetSingleUnit from '../fixtures/jet-single-unit.json';
import pvGenerating from '../fixtures/pv-generating.json';
import { FAST_OPTS, waitFor } from './helpers';

// The PV fixture defines only a frame; its registers come from the JET one,
// so the control register set stays single sourced. See its _note.
const generatingScenario = {
  ...(jetSingleUnit as unknown as Scenario),
  last_poll: pvGenerating.last_poll,
} as unknown as Scenario;

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

function settingsFor(port: number): AeccDeviceSettings {
  return {
    host: '127.0.0.1',
    port,
    brand: 'jet',
    maxChargePowerW: 800,
    maxDischargePowerW: 800,
    pollIntervalS: 2,
    verifyIntervalS: 0,
  };
}

interface LeaseSide {
  lease: SessionLease;
  snapshots: SessionSnapshot[];
}

/**
 * A stand-in for one device: the same SessionLease both drivers use, with
 * the transport timeouts this suite substitutes for real ones. The devices
 * themselves are Homey classes and cannot be constructed here, but every
 * line of session orchestration they run is in this lease.
 */
function deviceSide(reg: SessionRegistry): LeaseSide {
  const snapshots: SessionSnapshot[] = [];
  const lease = new SessionLease({
    registry: reg,
    scheduler: systemScheduler,
    jitterMs: () => 0,
    createSession: settings =>
      new AeccSession({
        ...sessionOptionsFrom(settings, systemScheduler),
        ...FAST_OPTS,
      }),
    onEvent: (event: SessionEvent) => {
      if (event.type === 'snapshot') snapshots.push(event.snapshot);
    },
  });
  return { lease, snapshots };
}

describe('a battery and a solar device sharing one session', () => {
  it('serves both the PV total over a single connection, and the lease starts it', async () => {
    sim = await AeccSimulator.start({
      scenario: generatingScenario,
      port: 0,
      // A second connection would be refused here, so a bug that gave each
      // device its own session fails loudly. On real hardware it would
      // not: the battery accepts the second session and then silently
      // ignores it, which is why this is a test and not a review note.
      refuseSecondConnection: true,
    });
    const settings = settingsFor(sim.port);
    registry = new SessionRegistry();

    const battery = deviceSide(registry);
    const solar = deviceSide(registry);

    // Nobody calls session.start() by hand: the lease that created the
    // session schedules it, which is the path the real devices take.
    const first = await battery.lease.acquire(settings);
    const second = await solar.lease.acquire(settings);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.session).toBe(first.session);
    expect(registry.size).toBe(1);

    await waitFor(() => solar.snapshots.length > 0);

    expect(battery.snapshots.length).toBeGreaterThan(0);
    expect(solar.snapshots.at(-1)?.telemetry?.pvTotalPowerW).toBe(758);
  }, 15000);

  it('gives a late joiner nothing until the next poll, while the snapshot getter already has the value', async () => {
    sim = await AeccSimulator.start({
      scenario: generatingScenario,
      port: 0,
      refuseSecondConnection: true,
    });
    const settings = settingsFor(sim.port);
    registry = new SessionRegistry();

    const battery = deviceSide(registry);
    await battery.lease.acquire(settings);
    await waitFor(() => battery.snapshots.length > 0);

    // Joining a session that is already polling, as the solar device does
    // when it is added to a battery that has been running for days.
    const solar = deviceSide(registry);
    const { session } = await solar.lease.acquire(settings);

    expect(solar.snapshots).toHaveLength(0);
    expect(session.snapshot.telemetry?.pvTotalPowerW).toBe(758);
  }, 15000);

  it('accumulates generated energy from the shared session', async () => {
    sim = await AeccSimulator.start({
      scenario: generatingScenario,
      port: 0,
      refuseSecondConnection: true,
    });
    const settings = settingsFor(sim.port);
    registry = new SessionRegistry();

    const solar = deviceSide(registry);
    const meter = new ProductionIntegrator();
    await solar.lease.acquire(settings);
    await waitFor(() => solar.snapshots.length >= 3);

    // Synthetic timestamps a minute apart rather than wall clock, so the
    // assertion is about the plumbing and not about how fast the poll loop
    // ran. A minute is also the integrator's gap ceiling.
    const watts: number[] = [];
    for (const snapshot of solar.snapshots) {
      const value = snapshot.telemetry?.pvTotalPowerW;
      if (value === null || value === undefined) continue;
      watts.push(value);
      meter.sample(watts.length * 60_000, value);
    }

    const intervals = watts.length - 1;
    expect(intervals).toBeGreaterThanOrEqual(2);
    expect(meter.generatedKwh).toBeCloseTo(
      (intervals * 758 * 60_000) / 3.6e9,
      6
    );
  }, 15000);

  it('moves both devices to a new address without leaving the old session running', async () => {
    const oldSim = await AeccSimulator.start({
      scenario: generatingScenario,
      port: 0,
      refuseSecondConnection: true,
    });
    sim = await AeccSimulator.start({
      scenario: generatingScenario,
      port: 0,
      refuseSecondConnection: true,
    });

    const oldSettings = settingsFor(oldSim.port);
    registry = new SessionRegistry();

    const battery = deviceSide(registry);
    const solar = deviceSide(registry);
    const { session: oldSession } = await battery.lease.acquire(oldSettings);
    await solar.lease.acquire(oldSettings);
    await waitFor(() => battery.snapshots.length > 0);

    // Exactly the order the devices use on a repair or an address edit:
    // the follower lets go first, the battery rebinds, the follower joins
    // whatever the battery bound to. Skipping the first step is what used
    // to leave a session polling an address nobody points at.
    await solar.lease.release();
    const newSettings = settingsFor(sim.port);
    const { session: newSession } = await battery.lease.acquire(newSettings);
    await solar.lease.acquire(newSettings);

    expect(newSession).not.toBe(oldSession);
    expect(registry.size).toBe(1);
    expect(battery.lease.key).toBe(`127.0.0.1:${sim.port}`);
    expect(solar.lease.key).toBe(battery.lease.key);

    const seenBefore = battery.snapshots.length;
    await waitFor(() => battery.snapshots.length > seenBefore);
    expect(battery.snapshots.at(-1)?.telemetry?.pvTotalPowerW).toBe(758);

    await oldSim.stop();
  }, 20000);

  it('keeps the session alive while either device still holds it', async () => {
    sim = await AeccSimulator.start({
      scenario: generatingScenario,
      port: 0,
      refuseSecondConnection: true,
    });
    const settings = settingsFor(sim.port);
    registry = new SessionRegistry();

    const battery = deviceSide(registry);
    const solar = deviceSide(registry);
    const { session } = await battery.lease.acquire(settings);
    await solar.lease.acquire(settings);
    await waitFor(() => battery.snapshots.length > 0);

    // The battery being deleted while its solar device remains.
    await battery.lease.release();
    expect(registry.size).toBe(1);
    // Still answering, which is what proves it was not stopped underneath
    // the device that still holds it.
    expect(await session.setMinSoc(20)).toBe(true);

    // A second release from the same lease must not touch the reference
    // the solar device is relying on.
    await battery.lease.release();
    expect(registry.size).toBe(1);
    expect(await session.setMinSoc(25)).toBe(true);

    await solar.lease.release();
    expect(registry.size).toBe(0);
  }, 20000);
});

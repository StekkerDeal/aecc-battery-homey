import { describe, expect, it, vi, type Mock } from 'vitest';
import { SessionLease } from './session-lease';
import { registryKeyFor, SessionRegistry } from '../session-registry';
import type {
  AeccSession,
  Scheduler,
  SchedulerHandle,
  SessionEvent,
} from '../session';
import type { AeccDeviceSettings } from './device-settings';

type OnEventFn = (event: SessionEvent) => void;
type CreateSessionFn = (settings: AeccDeviceSettings) => AeccSession;
type UnsubscribeFn = () => void;
type SubscribeFn = (listener: OnEventFn) => UnsubscribeFn;
type StartFn = () => Promise<void>;
type StopFn = () => Promise<void>;

interface FakeSession {
  start: Mock<StartFn>;
  stop: Mock<StopFn>;
  subscribe: Mock<SubscribeFn>;
  unsubscribe: Mock<UnsubscribeFn>;
  emit: (event: SessionEvent) => void;
}

// subscribe/unsubscribe keep a real listener set, not just call counts, so a
// test can prove delivery actually stops after release rather than only
// checking that unsubscribe was called.
function fakeSession(): FakeSession {
  const listeners = new Set<OnEventFn>();
  const unsubscribe = vi.fn<UnsubscribeFn>(() => {
    listeners.clear();
  });
  const subscribe = vi.fn<SubscribeFn>((listener: OnEventFn) => {
    listeners.add(listener);
    return unsubscribe;
  });
  return {
    start: vi.fn<StartFn>().mockResolvedValue(undefined),
    stop: vi.fn<StopFn>().mockResolvedValue(undefined),
    subscribe,
    unsubscribe,
    emit: (event: SessionEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function asSession(fake: FakeSession): AeccSession {
  return fake as unknown as AeccSession;
}

function toFake(session: AeccSession): FakeSession {
  return session as unknown as FakeSession;
}

function buildSettings(
  overrides: Partial<AeccDeviceSettings> = {}
): AeccDeviceSettings {
  return {
    host: '192.168.1.40',
    port: 8080,
    pollIntervalS: 5,
    brand: 'jet',
    maxChargePowerW: 800,
    maxDischargePowerW: 800,
    verifyIntervalS: 60,
    ...overrides,
  };
}

interface ScheduledCall {
  readonly ms: number;
  cancelled: boolean;
  readonly handler: () => void;
}

// A controllable stand-in for Homey's scheduler: setTimeout only records the
// call, it never fires on its own. A test fires or cancels it by hand, and
// fire() respects a prior clearTimeout the same way a real timer would, so a
// cancelled call staying silent is proof clearTimeout actually happened.
function createFakeScheduler(): {
  scheduler: Scheduler;
  calls: ScheduledCall[];
  fire: (call: ScheduledCall | undefined) => void;
} {
  const calls: ScheduledCall[] = [];
  const scheduler: Scheduler = {
    setTimeout: (handler, ms) => {
      const call: ScheduledCall = { ms, cancelled: false, handler };
      calls.push(call);
      return call;
    },
    clearTimeout: (handle: SchedulerHandle) => {
      (handle as ScheduledCall).cancelled = true;
    },
    now: () => 0,
  };
  const fire = (call: ScheduledCall | undefined): void => {
    if (!call || call.cancelled) return;
    call.handler();
  };
  return { scheduler, calls, fire };
}

function createLease(options: {
  registry: SessionRegistry;
  onEvent?: Mock<OnEventFn>;
  createSession?: Mock<CreateSessionFn>;
  jitterMs?: () => number;
}): {
  lease: SessionLease;
  onEvent: Mock<OnEventFn>;
  createSession: Mock<CreateSessionFn>;
  calls: ScheduledCall[];
  fire: (call: ScheduledCall | undefined) => void;
} {
  const { scheduler, calls, fire } = createFakeScheduler();
  const onEvent = options.onEvent ?? vi.fn<OnEventFn>();
  const createSession =
    options.createSession ??
    vi.fn<CreateSessionFn>(() => asSession(fakeSession()));
  const lease = new SessionLease({
    registry: options.registry,
    scheduler,
    createSession,
    onEvent,
    jitterMs: options.jitterMs ?? (() => 0),
  });
  return { lease, onEvent, createSession, calls, fire };
}

describe('SessionLease', () => {
  describe('acquire', () => {
    it('returns the session the factory made, created true, and index 0 for a first key', async () => {
      const registry = new SessionRegistry();
      const createSession = vi.fn<CreateSessionFn>(() =>
        asSession(fakeSession())
      );
      const { lease } = createLease({ registry, createSession });

      const outcome = await lease.acquire(buildSettings());

      expect(outcome.session).toBe(createSession.mock.results[0]?.value);
      expect(outcome.created).toBe(true);
      expect(outcome.index).toBe(0);
    });

    it('is false before acquire and true after, and key is exactly host:port', async () => {
      const registry = new SessionRegistry();
      const { lease } = createLease({ registry });
      const settings = buildSettings({ host: '10.0.0.9', port: 502 });

      expect(lease.held).toBe(false);

      await lease.acquire(settings);

      expect(lease.held).toBe(true);
      expect(lease.key).toBe('10.0.0.9:502');
    });

    it('gives a second lease on the same host and port the same session, created false, the same index, and calls the factory only once', async () => {
      const registry = new SessionRegistry();
      const createSession = vi.fn<CreateSessionFn>(() =>
        asSession(fakeSession())
      );
      const first = createLease({ registry, createSession });
      const second = createLease({ registry, createSession });
      const settings = buildSettings();

      const firstOutcome = await first.lease.acquire(settings);
      const secondOutcome = await second.lease.acquire(settings);

      expect(secondOutcome.session).toBe(firstOutcome.session);
      expect(secondOutcome.created).toBe(false);
      expect(secondOutcome.index).toBe(firstOutcome.index);
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('throws from requireSession before any acquire and returns the session after one', async () => {
      const registry = new SessionRegistry();
      const { lease } = createLease({ registry });

      expect(() => lease.requireSession()).toThrow(
        'This device is not connected to a battery session.'
      );

      const outcome = await lease.acquire(buildSettings());

      expect(lease.requireSession()).toBe(outcome.session);
    });

    it('subscribes to the session and passes events through to onEvent', async () => {
      const registry = new SessionRegistry();
      const onEvent = vi.fn<OnEventFn>();
      const { lease } = createLease({ registry, onEvent });

      const outcome = await lease.acquire(buildSettings());
      const fake = toFake(outcome.session);
      const event: SessionEvent = { type: 'available' };

      fake.emit(event);

      expect(onEvent).toHaveBeenCalledWith(event);
    });
  });

  describe('starting', () => {
    it('schedules a start at index * 1000 + jitter, and only calls session.start() once the fake scheduler fires it', async () => {
      const registry = new SessionRegistry();
      const { lease, calls, fire } = createLease({ registry });

      const outcome = await lease.acquire(buildSettings());
      const fake = toFake(outcome.session);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.ms).toBe(0);
      expect(fake.start).not.toHaveBeenCalled();

      fire(calls[0]);

      expect(fake.start).toHaveBeenCalledTimes(1);
    });

    it('schedules nothing and never calls start() for a lease that joins an existing session', async () => {
      const registry = new SessionRegistry();
      const settings = buildSettings();
      const existing = asSession(fakeSession());
      registry.acquire(
        registryKeyFor(settings.host, settings.port),
        () => existing
      );
      const { lease, calls } = createLease({ registry });

      const outcome = await lease.acquire(settings);

      expect(outcome.created).toBe(false);
      expect(calls).toHaveLength(0);
      expect(toFake(outcome.session).start).not.toHaveBeenCalled();
    });

    it('uses a delay of exactly 1007 with jitterMs () => 7 and a registry index of 1', async () => {
      const registry = new SessionRegistry();
      registry.acquire('other:1', () => asSession(fakeSession()));
      const { lease, calls } = createLease({ registry, jitterMs: () => 7 });

      const outcome = await lease.acquire(buildSettings());

      expect(outcome.index).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.ms).toBe(1007);
    });
  });

  describe('release', () => {
    it('unsubscribes, drops held to false, blanks key, and lets the registry stop the session when the last reference goes', async () => {
      const registry = new SessionRegistry();
      const { lease } = createLease({ registry });
      const outcome = await lease.acquire(buildSettings());
      const fake = toFake(outcome.session);

      await lease.release();

      expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
      expect(lease.held).toBe(false);
      expect(lease.key).toBe('');
      expect(fake.stop).toHaveBeenCalledTimes(1);
      expect(registry.size).toBe(0);
    });

    it('does not stop the session while a second lease still references it, and stops it on the second release', async () => {
      const registry = new SessionRegistry();
      const first = createLease({ registry });
      const second = createLease({ registry });
      const settings = buildSettings();

      const outcome = await first.lease.acquire(settings);
      await second.lease.acquire(settings);
      const fake = toFake(outcome.session);

      await first.lease.release();

      expect(fake.stop).not.toHaveBeenCalled();
      expect(registry.size).toBe(1);

      await second.lease.release();

      expect(fake.stop).toHaveBeenCalledTimes(1);
      expect(registry.size).toBe(0);
    });

    it('releases the underlying reference only once when release is called twice on one lease', async () => {
      const registry = new SessionRegistry();
      const first = createLease({ registry });
      const second = createLease({ registry });
      const settings = buildSettings();

      const outcome = await first.lease.acquire(settings);
      await second.lease.acquire(settings);
      const fake = toFake(outcome.session);

      await first.lease.release();
      await first.lease.release();

      expect(fake.stop).not.toHaveBeenCalled();
      expect(registry.size).toBe(1);
      expect(second.lease.held).toBe(true);
    });

    it('is a no-op and does not throw for a lease that never acquired', async () => {
      const registry = new SessionRegistry();
      const { lease } = createLease({ registry });

      await expect(lease.release()).resolves.toBeUndefined();

      expect(lease.held).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('cancels a pending start on release, so a late timer fire never calls session.start()', async () => {
      const registry = new SessionRegistry();
      const { lease, calls, fire } = createLease({ registry });

      const outcome = await lease.acquire(buildSettings());
      const fake = toFake(outcome.session);

      await lease.release();
      fire(calls[0]);

      expect(fake.start).not.toHaveBeenCalled();
    });
  });

  describe('re-acquiring', () => {
    it('releases the old key first when acquiring a different host: the old session is stopped, the registry ends with exactly one entry, and the new session is a different object', async () => {
      const registry = new SessionRegistry();
      const { lease } = createLease({ registry });

      const firstOutcome = await lease.acquire(
        buildSettings({ host: '10.0.0.1', port: 502 })
      );
      const firstFake = toFake(firstOutcome.session);

      const secondOutcome = await lease.acquire(
        buildSettings({ host: '10.0.0.2', port: 502 })
      );

      expect(firstFake.stop).toHaveBeenCalledTimes(1);
      expect(registry.size).toBe(1);
      expect(secondOutcome.session).not.toBe(firstOutcome.session);
    });

    it('produces a fresh session on re-acquiring the same address after a release, and the lease is held again', async () => {
      const registry = new SessionRegistry();
      const { lease } = createLease({ registry });
      const settings = buildSettings();

      const firstOutcome = await lease.acquire(settings);
      await lease.release();
      const secondOutcome = await lease.acquire(settings);

      expect(secondOutcome.session).not.toBe(firstOutcome.session);
      expect(secondOutcome.created).toBe(true);
      expect(lease.held).toBe(true);
    });

    it('unsubscribes the old session on rebind: an event emitted on the old session afterward never reaches onEvent', async () => {
      const registry = new SessionRegistry();
      const onEvent = vi.fn<OnEventFn>();
      const { lease } = createLease({ registry, onEvent });

      const firstOutcome = await lease.acquire(
        buildSettings({ host: '10.0.0.1', port: 502 })
      );
      const firstFake = toFake(firstOutcome.session);

      await lease.acquire(buildSettings({ host: '10.0.0.2', port: 502 }));
      onEvent.mockClear();

      firstFake.emit({ type: 'available' });

      expect(onEvent).not.toHaveBeenCalled();
    });
  });
});

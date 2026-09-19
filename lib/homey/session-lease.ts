import type {
  AeccSession,
  Scheduler,
  SchedulerHandle,
  SessionEvent,
} from '../session';
import { registryKeyFor, type SessionRegistry } from '../session-registry';
import type { AeccDeviceSettings } from './device-settings';

export interface SessionLeaseDeps {
  registry: SessionRegistry;
  scheduler: Scheduler;
  createSession: (settings: AeccDeviceSettings) => AeccSession;
  onEvent: (event: SessionEvent) => void;
  // Injectable so a test can assert the stagger without waiting on chance.
  jitterMs?: () => number;
}

export interface LeaseOutcome {
  session: AeccSession;
  created: boolean;
  index: number;
}

const STAGGER_STEP_MS = 1000;
const DEFAULT_JITTER_MS = 250;

/**
 * One device's hold on the shared session for one battery.
 *
 * This is the part that used to be copied into each device: take a
 * reference from the registry, subscribe, start it if we are the one who
 * created it, and give the reference back exactly once. Two drivers now
 * point at the same battery, which serves a single TCP session and accepts
 * a second one only to ignore it silently, so every mistake in here is
 * invisible at runtime. It lives in lib/ so it can be tested against fake
 * sessions instead of being reviewed by eye.
 *
 * The invariants it exists to keep:
 *  - at most one outstanding reference per lease, so a release can never
 *    decrement a count another device is relying on;
 *  - a key is blanked on release, so a second release is a no-op rather
 *    than a silent theft of someone else's session;
 *  - a pending start is always cancelled with the reference it belongs to,
 *    because a timer that fires after release starts a session nobody is
 *    tracking, which then holds the battery's only slot;
 *  - only the creator starts the session, staggered by registry index.
 */
export class SessionLease {
  private readonly deps: SessionLeaseDeps;
  private sessionValue: AeccSession | null = null;
  private keyValue = '';
  private unsubscribe: (() => void) | null = null;
  private pendingStart: SchedulerHandle | null = null;

  constructor(deps: SessionLeaseDeps) {
    this.deps = deps;
  }

  get session(): AeccSession | null {
    return this.sessionValue;
  }

  get key(): string {
    return this.keyValue;
  }

  get held(): boolean {
    return this.sessionValue !== null;
  }

  /**
   * The session, for callers that cannot proceed without one.
   *
   * Throws a sentence rather than letting a `null` reach the transport,
   * where it would surface as a TypeError inside an unrelated stack.
   */
  requireSession(): AeccSession {
    if (this.sessionValue === null) {
      throw new Error('This device is not connected to a battery session.');
    }
    return this.sessionValue;
  }

  /**
   * Takes a reference for this address, releasing any previous one first.
   *
   * Also the rebind path: acquiring a different address is release plus
   * acquire, in that order, so the old session is never left running for a
   * device that has moved on.
   */
  async acquire(settings: AeccDeviceSettings): Promise<LeaseOutcome> {
    await this.release();

    const key = registryKeyFor(settings.host, settings.port);
    let created = false;
    const { session, index } = this.deps.registry.acquire(key, () => {
      created = true;
      return this.deps.createSession(settings);
    });

    this.sessionValue = session;
    this.keyValue = key;
    this.unsubscribe = session.subscribe(this.deps.onEvent);
    this.scheduleStart(created, session, index);

    return { session, created, index };
  }

  /** Gives the reference back. Safe to call when nothing is held. */
  async release(): Promise<void> {
    if (this.sessionValue === null) return;
    const key = this.keyValue;

    this.clearPendingStart();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sessionValue = null;
    this.keyValue = '';

    await this.deps.registry.release(key);
  }

  private scheduleStart(
    created: boolean,
    session: AeccSession,
    index: number
  ): void {
    if (!created) return;
    const jitter = this.deps.jitterMs ?? defaultJitter;
    const delayMs = index * STAGGER_STEP_MS + jitter();
    this.pendingStart = this.deps.scheduler.setTimeout(() => {
      this.pendingStart = null;
      void session.start();
    }, delayMs);
  }

  private clearPendingStart(): void {
    if (this.pendingStart === null) return;
    this.deps.scheduler.clearTimeout(this.pendingStart);
    this.pendingStart = null;
  }
}

function defaultJitter(): number {
  return Math.floor(Math.random() * DEFAULT_JITTER_MS);
}

import type { AeccSession } from './session';

interface RegistryEntry {
  session: AeccSession;
  refCount: number;
  index: number;
}

export interface AcquireResult {
  session: AeccSession;
  index: number;
}

/**
 * The registry key for one datalogger. It lives here, next to the map it
 * keys, because every driver that shares a battery must derive the exact
 * same string: two spellings of the same address would each get their own
 * entry, and the battery would be dialled twice. Hardware accepts that
 * second TCP session and then silently ignores it, so the mistake shows up
 * as a device that looks connected and never updates, not as an error.
 */
export function registryKeyFor(host: string, port: number): string {
  return `${host}:${port}`;
}

/**
 * Reference-counted registry enforcing one AeccSession per host:port key,
 * the protocol's single-TCP-session-per-device rule, even if a user pairs
 * the same datalogger under two Homey devices.
 */
export class SessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private nextIndex = 0;

  acquire(key: string, factory: () => AeccSession): AcquireResult {
    const existing = this.entries.get(key);
    if (existing) {
      existing.refCount += 1;
      return { session: existing.session, index: existing.index };
    }
    const session = factory();
    const index = this.nextIndex;
    this.nextIndex += 1;
    this.entries.set(key, { session, refCount: 1, index });
    return { session, index };
  }

  async release(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      this.entries.delete(key);
      await entry.session.stop();
    }
  }

  get size(): number {
    return this.entries.size;
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.entries.values()].map(e => e.session);
    this.entries.clear();
    await Promise.all(sessions.map(session => session.stop()));
  }
}

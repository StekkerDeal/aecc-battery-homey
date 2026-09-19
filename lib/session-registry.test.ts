import { describe, expect, it, vi } from 'vitest';
import { registryKeyFor, SessionRegistry } from './session-registry';
import type { AeccSession } from './session';

function fakeSession(): AeccSession {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as AeccSession;
}

describe('registryKeyFor', () => {
  it('produces exactly host:port', () => {
    expect(registryKeyFor('192.168.1.40', 8080)).toBe('192.168.1.40:8080');
  });

  it('gives two different keys for the same host on two different ports', () => {
    const first = registryKeyFor('192.168.1.40', 8080);
    const second = registryKeyFor('192.168.1.40', 8081);
    expect(first).not.toBe(second);
  });

  it('passes a hostname through untouched: not lowercased, not trimmed, not rewritten', () => {
    expect(registryKeyFor('  MyHost.Local  ', 502)).toBe(
      '  MyHost.Local  :502'
    );
  });

  // This is the single-TCP-session invariant expressed as a test: two
  // drivers deriving different keys for the same battery would dial it
  // twice. test/integration/session-registry.test.ts builds its key by hand
  // as `127.0.0.1:${port}`; that literal must agree with registryKeyFor, or
  // the integration test would be exercising a key the real registry never
  // uses.
  it('agrees with the key the integration test builds by hand', () => {
    const port = 12345;
    const handBuilt = `127.0.0.1:${port}`;
    expect(registryKeyFor('127.0.0.1', port)).toBe(handBuilt);
  });
});

describe('SessionRegistry.acquire', () => {
  it('creates a new session via the factory on first acquire', () => {
    const registry = new SessionRegistry();
    const session = fakeSession();
    const factory = vi.fn(() => session);

    const result = registry.acquire('h:1', factory);

    expect(result.session).toBe(session);
    expect(result.index).toBe(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  it('returns the same session on a second acquire without calling the factory again', () => {
    const registry = new SessionRegistry();
    const session = fakeSession();
    const factory = vi.fn(() => session);

    registry.acquire('h:1', factory);
    const second = registry.acquire('h:1', factory);

    expect(second.session).toBe(session);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  it('assigns increasing index per distinct key, in registration order', () => {
    const registry = new SessionRegistry();
    const first = registry.acquire('a:1', () => fakeSession());
    const second = registry.acquire('b:1', () => fakeSession());
    const third = registry.acquire('c:1', () => fakeSession());

    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(third.index).toBe(2);
  });

  it('re-acquiring an existing key keeps its original index', () => {
    const registry = new SessionRegistry();
    registry.acquire('a:1', () => fakeSession());
    registry.acquire('b:1', () => fakeSession());
    const reacquired = registry.acquire('a:1', () => fakeSession());

    expect(reacquired.index).toBe(0);
  });
});

describe('SessionRegistry.release', () => {
  it('does not stop a session while another acquire still references it', async () => {
    const registry = new SessionRegistry();
    const session = fakeSession();
    registry.acquire('h:1', () => session);
    registry.acquire('h:1', () => session);

    await registry.release('h:1');

    expect(session.stop).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it('stops the session once the reference count reaches zero', async () => {
    const registry = new SessionRegistry();
    const session = fakeSession();
    registry.acquire('h:1', () => session);
    registry.acquire('h:1', () => session);

    await registry.release('h:1');
    await registry.release('h:1');

    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('is a no-op for an unknown key', async () => {
    const registry = new SessionRegistry();
    await expect(registry.release('missing:1')).resolves.toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('acquiring again after full release creates a fresh session via the factory', async () => {
    const registry = new SessionRegistry();
    const first = fakeSession();
    const second = fakeSession();
    const factory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    registry.acquire('h:1', factory);
    await registry.release('h:1');

    const result = registry.acquire('h:1', factory);
    expect(result.session).toBe(second);
    expect(result.index).toBe(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('SessionRegistry.stopAll', () => {
  it('stops every registered session and clears the registry', async () => {
    const sessionA = fakeSession();
    const sessionB = fakeSession();
    const registry = new SessionRegistry();
    registry.acquire('a:1', () => sessionA);
    registry.acquire('b:1', () => sessionB);

    await registry.stopAll();

    expect(sessionA.stop).toHaveBeenCalledTimes(1);
    expect(sessionB.stop).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('is a no-op on an empty registry', async () => {
    const registry = new SessionRegistry();
    await expect(registry.stopAll()).resolves.toBeUndefined();
  });
});

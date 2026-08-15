import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AeccConnection,
  type SocketFactory,
  type SocketLike,
} from './connection';

class FakeSocket extends EventEmitter implements SocketLike {
  destroyed = false;
  writes: Array<string | Buffer> = [];
  endCalls = 0;
  destroyCalls = 0;

  write(data: string | Buffer, callback?: (err?: Error) => void): boolean {
    this.writes.push(data);
    callback?.();
    return true;
  }

  end(callback?: () => void): void {
    this.endCalls += 1;
    callback?.();
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.emit('close');
  }

  connect(): void {
    this.emit('connect');
  }

  fail(err: Error): void {
    this.emit('error', err);
  }
}

function factoryFor(sockets: FakeSocket[]): SocketFactory {
  let i = 0;
  return () => {
    const socket = sockets[i];
    i += 1;
    if (!socket) throw new Error('factory ran out of fake sockets');
    return socket;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AeccConnection.connect', () => {
  it('resolves once the socket connects', async () => {
    const socket = new FakeSocket();
    const conn = new AeccConnection({
      host: '127.0.0.1',
      port: 8080,
      socketFactory: factoryFor([socket]),
    });

    const pending = conn.connect();
    socket.connect();
    const result = await pending;

    expect(result).toBe(socket);
    expect(conn.isConnected).toBe(true);
  });

  it('reuses a live socket instead of dialing again', async () => {
    const socket = new FakeSocket();
    const factory = vi.fn(() => socket);
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      socketFactory: factory,
    });

    const first = conn.connect();
    socket.connect();
    await first;

    const second = await conn.connect();
    expect(second).toBe(socket);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('rejects and destroys the socket on a connect timeout', async () => {
    const socket = new FakeSocket();
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      connectTimeoutMs: 5000,
      socketFactory: factoryFor([socket]),
    });

    const pending = conn.connect();
    const assertion = expect(pending).rejects.toThrow(/connect timeout/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(socket.destroyCalls).toBe(1);
    expect(conn.isConnected).toBe(false);
  });

  it('rejects on a socket error before connect', async () => {
    const socket = new FakeSocket();
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      socketFactory: factoryFor([socket]),
    });

    const pending = conn.connect();
    const assertion = expect(pending).rejects.toThrow('refused');
    socket.fail(new Error('refused'));
    await assertion;
    expect(conn.isConnected).toBe(false);
  });

  it('dials a fresh socket after the previous one closed', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const factory = factoryFor([first, second]);
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      socketFactory: factory,
    });

    const p1 = conn.connect();
    first.connect();
    await p1;

    first.destroy();
    expect(conn.isConnected).toBe(false);

    const p2 = conn.connect();
    second.connect();
    const result = await p2;
    expect(result).toBe(second);
  });

  it('does not crash the process on a post-connect socket error', async () => {
    const socket = new FakeSocket();
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      socketFactory: factoryFor([socket]),
    });

    const pending = conn.connect();
    socket.connect();
    await pending;

    expect(() => socket.emit('error', new Error('late error'))).not.toThrow();
  });
});

describe('AeccConnection.close', () => {
  it('is a no-op when never connected', async () => {
    const conn = new AeccConnection({ host: 'h', port: 1 });
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it('calls end() then destroy() after the grace period when close never fires', async () => {
    const socket = new FakeSocket();
    socket.end = (): void => {
      socket.endCalls += 1;
      // Deliberately does not emit 'close', modelling an unresponsive peer.
    };
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      closeGraceMs: 200,
      socketFactory: factoryFor([socket]),
    });

    const pending = conn.connect();
    socket.connect();
    await pending;

    const closePromise = conn.close();
    await vi.advanceTimersByTimeAsync(200);
    await closePromise;

    expect(socket.endCalls).toBe(1);
    expect(socket.destroyCalls).toBe(1);
    expect(conn.isConnected).toBe(false);
  });

  it('resolves as soon as close fires, without waiting the full grace period', async () => {
    const socket = new FakeSocket();
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      closeGraceMs: 5000,
      socketFactory: factoryFor([socket]),
    });

    const pending = conn.connect();
    socket.connect();
    await pending;

    const originalEnd = socket.end.bind(socket);
    socket.end = (callback?: () => void): void => {
      originalEnd(callback);
      socket.destroy();
    };

    await conn.close();
    expect(socket.destroyCalls).toBe(1);
  });

  it('is a no-op when the socket is already destroyed', async () => {
    const socket = new FakeSocket();
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      socketFactory: factoryFor([socket]),
    });
    const pending = conn.connect();
    socket.connect();
    await pending;

    socket.destroy();
    await expect(conn.close()).resolves.toBeUndefined();
  });
});

describe('AeccConnection.backoff', () => {
  it('exposes a Backoff instance that only the caller mutates', () => {
    const conn = new AeccConnection({ host: 'h', port: 1 });
    expect(conn.backoff.consecutiveFailures).toBe(0);
    conn.backoff.noteFailure();
    expect(conn.backoff.consecutiveFailures).toBe(1);
  });

  it('honours custom backoff base/max', () => {
    const conn = new AeccConnection({
      host: 'h',
      port: 1,
      backoffBaseMs: 10,
      backoffMaxMs: 20,
    });
    expect(conn.backoff.currentCooldownMs()).toBe(10);
    conn.backoff.noteFailure();
    expect(conn.backoff.currentCooldownMs()).toBe(20);
  });
});

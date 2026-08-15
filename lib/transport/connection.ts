import * as net from 'node:net';
import { Backoff } from './backoff';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_CLOSE_GRACE_MS = 200;

// Structural subset of net.Socket this module needs, so unit tests can drive
// AeccConnection with a fake in-memory socket instead of real networking.
export interface SocketLike {
  readonly destroyed: boolean;
  write(
    data: string | Buffer,
    callback?: (err?: Error | null) => void
  ): boolean;
  end(callback?: () => void): void;
  destroy(error?: Error): void;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
}

export type SocketFactory = (host: string, port: number) => SocketLike;

export interface AeccConnectionOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
  closeGraceMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  socketFactory?: SocketFactory;
}

const defaultSocketFactory: SocketFactory = (host, port) =>
  net.createConnection({ host, port });

/**
 * Owns one socket for one host:port pair. Backoff state lives here but is
 * only mutated by the caller (AeccClient), mirroring the ported Python split.
 */
export class AeccConnection {
  readonly backoff: Backoff;

  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly socketFactory: SocketFactory;
  private socket: SocketLike | null = null;

  constructor(options: AeccConnectionOptions) {
    this.host = options.host;
    this.port = options.port;
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.backoff = new Backoff(options.backoffBaseMs, options.backoffMaxMs);
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  // Reuses a live socket; otherwise dials a new one within connectTimeoutMs.
  async connect(): Promise<SocketLike> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const socket = this.socketFactory(this.host, this.port);
    await this.awaitConnected(socket);
    this.socket = socket;
    // A socket with no 'error' listener throws on error and crashes the
    // process; callers detect failure through their own read/write, not
    // through this listener.
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
    });
    return socket;
  }

  private awaitConnected(socket: SocketLike): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const onConnect = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('connect', onConnect);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.off('connect', onConnect);
        socket.off('error', onError);
        socket.destroy();
        reject(
          new Error(
            `connect timeout after ${this.connectTimeoutMs}ms to ${this.host}:${this.port}`
          )
        );
      }, this.connectTimeoutMs);

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  // Releasing the socket cleanly matters: a stuck FD on the device end after
  // an app update/reload is a documented failure mode on this device class.
  // end() first, then destroy() after a short grace period regardless of
  // whether the remote ever acknowledged the close.
  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.destroyed) return;
    await new Promise<void>(resolve => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(graceTimer);
        resolve();
      };
      const graceTimer = setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
        finish();
      }, this.closeGraceMs);
      socket.once('close', finish);
      socket.end();
    });
  }
}

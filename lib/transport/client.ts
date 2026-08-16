import {
  buildGet,
  buildSet,
  encodeRequest,
  JsonAccumulator,
  readRegister,
  unwrapContainer,
  type RequestPayload,
} from '../protocol/frames';
import {
  DEVICE_MANAGEMENT_SAFE_REGISTERS,
  DM_FIRMWARE,
  DM_MODEL,
  DM_RSSI,
  DM_SERIAL,
} from '../protocol/registers';
import type { DeviceIdentity } from '../types';
import type { Logger } from '../logger';
import { silentLogger } from '../logger';
import {
  AeccConnection,
  type SocketFactory,
  type SocketLike,
} from './connection';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_READ_TIMEOUT_MS = 10000;
const DEFAULT_DEVICE_MANAGEMENT_TIMEOUT_MS = 3000;
// 3 consecutive silent reads (device connected but never replies) recycle
// the socket, it is likely half-open after a device-side reset.
const READ_TIMEOUT_STREAK_LIMIT = 3;

export interface AeccClientOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  deviceManagementTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  closeGraceMs?: number;
  socketFactory?: SocketFactory;
  logger?: Logger;
}

class ReadTimeoutError extends Error {}
class ProtocolError extends Error {
  constructor(
    message: string,
    readonly preview: string = '',
    readonly byteLength: number = 0
  ) {
    super(message);
  }
}

// Serialises async work one-at-a-time in call order, the Python _io_lock
// equivalent. Exported so lib/session.ts can reuse it for the write lock.
export class RequestQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const started = this.tail.then(fn);
    this.tail = started.then(
      () => undefined,
      () => undefined
    );
    return started;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeField(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * TCP protocol client for one AECC device: one request in-flight at a time,
 * reconnect backoff, and every read/write resolves to null on failure.
 */
export class AeccClient {
  private readonly connection: AeccConnection;
  private readonly readTimeoutMs: number;
  private readonly deviceManagementTimeoutMs: number;
  private readonly logger: Logger;
  private readonly queue = new RequestQueue();

  private serial = 0;
  private readTimeoutStreak = 0;

  constructor(options: AeccClientOptions) {
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.deviceManagementTimeoutMs =
      options.deviceManagementTimeoutMs ?? DEFAULT_DEVICE_MANAGEMENT_TIMEOUT_MS;
    this.logger = options.logger ?? silentLogger;
    this.connection = new AeccConnection({
      host: options.host,
      port: options.port,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      closeGraceMs: options.closeGraceMs,
      backoffBaseMs: options.backoffBaseMs,
      backoffMaxMs: options.backoffMaxMs,
      socketFactory: options.socketFactory,
    });
  }

  get consecutiveFailures(): number {
    return this.connection.backoff.consecutiveFailures;
  }

  async connect(): Promise<void> {
    await this.connection.connect();
    this.connection.backoff.noteSuccess();
  }

  async disconnect(): Promise<void> {
    await this.connection.close();
  }

  async getEnergyParameters(): Promise<Record<string, unknown> | null> {
    const payload = buildGet('EnergyParameter', this.nextSerial());
    return this.dispatch(payload, this.readTimeoutMs, 'GET', 'EnergyParameter');
  }

  async getControlParameters(
    registers: number[]
  ): Promise<Record<string, unknown> | null> {
    const payload = buildGet('Energycontrolparameters', this.nextSerial(), {
      RegControlAddr: registers,
    });
    return this.dispatch(
      payload,
      this.readTimeoutMs,
      'GET',
      'Energycontrolparameters'
    );
  }

  async setControlParameters(
    values: Record<string, string>
  ): Promise<Record<string, unknown> | null> {
    const payload = buildSet('Energycontrolparameters', this.nextSerial(), {
      SetControlInfo: values,
    });
    return this.dispatch(
      payload,
      this.readTimeoutMs,
      'SET',
      'Energycontrolparameters'
    );
  }

  // Fixed safe register list only. Registers 56/57 return the WiFi SSID and
  // password in cleartext, so callers may never widen this request, and the
  // response body must never be logged anywhere in this class.
  async getDeviceIdentity(): Promise<DeviceIdentity | null> {
    const payload = buildGet('DeviceManagement', this.nextSerial(), {
      RegDeviceManagementAddr: [...DEVICE_MANAGEMENT_SAFE_REGISTERS],
    });
    const resp = await this.dispatch(
      payload,
      this.deviceManagementTimeoutMs,
      'GET',
      'DeviceManagement'
    );
    if (resp === null) return null;
    const params = unwrapContainer(resp, 'devicemanagement');
    if (params === null) return null;
    return this.parseDeviceIdentity(params);
  }

  private parseDeviceIdentity(params: Record<string, unknown>): DeviceIdentity {
    const serial = normalizeField(readRegister(params, DM_SERIAL));
    const model = normalizeField(readRegister(params, DM_MODEL));
    const firmware = normalizeField(readRegister(params, DM_FIRMWARE));
    const rssiRaw = normalizeField(readRegister(params, DM_RSSI));
    const rssiNum = rssiRaw === undefined ? NaN : Number(rssiRaw);
    return {
      serial,
      model,
      firmware,
      rssi: Number.isFinite(rssiNum) ? Math.trunc(rssiNum) : undefined,
    };
  }

  private nextSerial(): number {
    this.serial += 1;
    return this.serial;
  }

  private dispatch(
    payload: RequestPayload,
    timeoutMs: number,
    op: 'GET' | 'SET',
    command: string
  ): Promise<Record<string, unknown> | null> {
    return this.queue.run(() =>
      this.performRequest(payload, timeoutMs, op, command)
    );
  }

  private async performRequest(
    payload: RequestPayload,
    timeoutMs: number,
    op: string,
    command: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const socket = await this.connection.connect();
      const response = await this.writeAndRead(socket, payload, timeoutMs);
      this.connection.backoff.noteSuccess();
      this.readTimeoutStreak = 0;
      return response;
    } catch (err) {
      if (err instanceof ReadTimeoutError) {
        await this.handleReadTimeout(op, command);
        return null;
      }
      if (err instanceof ProtocolError) {
        // A DeviceManagement body never reaches the log. The safe register
        // list already keeps WiFi credentials out of the response, but the
        // body stays out regardless so widening that list cannot leak them.
        const detail =
          command === 'DeviceManagement'
            ? `${err.byteLength} bytes`
            : `${err.byteLength} bytes: ${err.preview}`;
        this.logger.error(
          `${op} ${command} protocol error: ${err.message} (${detail})`
        );
        return null;
      }
      await this.handleConnectionError(op, command, err);
      return null;
    }
  }

  private writeAndRead(
    socket: SocketLike,
    payload: RequestPayload,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const acc = new JsonAccumulator();
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const finishResolve = (value: Record<string, unknown>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => {
        finishReject(new ReadTimeoutError(`read timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const onData = (chunk: unknown): void => {
        if (!(chunk instanceof Buffer)) return;
        const parsed = acc.push(chunk);
        if (parsed === null) return;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          finishResolve(parsed as Record<string, unknown>);
        } else {
          finishReject(
            new ProtocolError(
              'response was not a JSON object',
              acc.preview,
              acc.byteLength
            )
          );
        }
      };
      const onError = (err: unknown): void => {
        finishReject(err instanceof Error ? err : new Error(String(err)));
      };
      const onClose = (): void => {
        finishReject(new Error('connection closed before response'));
      };

      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);

      socket.write(encodeRequest(payload), err => {
        if (err) finishReject(err);
      });
    });
  }

  private async handleReadTimeout(op: string, command: string): Promise<void> {
    this.readTimeoutStreak += 1;
    this.logger.error(
      `${op} ${command}: read timeout (streak ${this.readTimeoutStreak})`
    );
    if (this.readTimeoutStreak >= READ_TIMEOUT_STREAK_LIMIT) {
      await this.connection.close();
      this.readTimeoutStreak = 0;
    }
  }

  private async handleConnectionError(
    op: string,
    command: string,
    err: unknown
  ): Promise<void> {
    const cooldownMs = this.connection.backoff.currentCooldownMs();
    this.logger.error(
      `${op} ${command} connection error: ${describeError(err)}, reconnecting after ${cooldownMs}ms`
    );
    this.connection.backoff.noteFailure();
    await sleep(cooldownMs);
    try {
      await this.connection.close();
      await this.connection.connect();
    } catch (reconnectErr) {
      this.logger.error(
        `${op} ${command} reconnect failed: ${describeError(reconnectErr)}`
      );
    }
  }
}

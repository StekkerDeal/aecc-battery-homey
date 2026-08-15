import * as net from 'node:net';
import type { StorageUnit } from '../../lib/types';
import { DEVICE_MANAGEMENT_SAFE_REGISTERS } from '../../lib/protocol/registers';

const SAFE_DM_REGISTERS = new Set<number>(DEVICE_MANAGEMENT_SAFE_REGISTERS);

export interface ScenarioFrame {
  Response?: string;
  SerialNumber?: number;
  Target?: string;
  Storage_list?: StorageUnit[];
  SSumInfoList?: Record<string, number | string>;
}

// Matches the output of extract-from-diagnostics.mjs: a captured or hand
// built poll plus the flat register map (control + device management
// registers share one number-keyed namespace, as on the real device).
export interface Scenario {
  last_poll: ScenarioFrame;
  registers: Record<string, string>;
}

export interface SimulatorOptions {
  scenario: Scenario;
  port?: number;
  dropWriteRate?: number;
  resetEveryNRequests?: number;
  responseDelayMs?: number;
  splitResponseInto?: number;
  omitStorageList?: boolean;
  deviceManagementTimeout?: boolean;
  refuseSecondConnection?: boolean;
}

export interface RecordedRequest {
  raw: string;
  parsed: unknown;
  at: number;
}

interface SimFrame {
  Storage_list?: StorageUnit[];
  SSumInfoList?: Record<string, number | string>;
}

function addressPort(address: net.AddressInfo | string | null): number {
  return address && typeof address === 'object' ? address.port : 0;
}

export class AeccSimulator {
  readonly port: number;
  readonly registers: Map<string, string>;
  readonly requests: RecordedRequest[] = [];

  private readonly options: SimulatorOptions;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private activeSocket: net.Socket | null = null;
  private readonly frame: SimFrame;
  private pendingRawFrame: unknown = null;
  private dropAccumulator = 0;
  private requestCounter = 0;

  private constructor(
    options: SimulatorOptions,
    server: net.Server,
    port: number
  ) {
    this.options = options;
    this.server = server;
    this.port = port;
    this.registers = new Map(Object.entries(options.scenario.registers));
    this.frame = {
      Storage_list: options.scenario.last_poll.Storage_list?.map(unit => ({
        ...unit,
      })),
      SSumInfoList: options.scenario.last_poll.SSumInfoList
        ? { ...options.scenario.last_poll.SSumInfoList }
        : undefined,
    };
  }

  static async start(o: SimulatorOptions): Promise<AeccSimulator> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(o.port ?? 0, '127.0.0.1', () => {
        server.off('error', onError);
        server.on('error', () => {
          // Swallow post-listen server errors so an accept-time failure
          // never crashes the test process; tests observe behaviour via
          // their own sockets, not via this server's error event.
        });
        const sim = new AeccSimulator(o, server, addressPort(server.address()));
        sim.attach();
        resolve(sim);
      });
    });
  }

  setSoc(pct: number): void {
    for (const unit of this.frame.Storage_list ?? []) unit.BatterySoc = pct;
    if (!this.frame.SSumInfoList) this.frame.SSumInfoList = {};
    this.frame.SSumInfoList.AverageBatteryAverageSOC = pct;
  }

  // Wall-side power: positive charges, negative discharges. Storage fields
  // are deciwatts (x10) and SSumInfoList fields are watts (x1), the same
  // mixed scaling the real device uses, so the two stay consistent.
  setPower(signedWallW: number): void {
    const magnitudeW = Math.round(Math.abs(signedWallW));
    const magnitudeDw = magnitudeW * 10;
    const units = this.frame.Storage_list ?? [];
    for (const unit of units) {
      unit.AcChargingPower = 0;
      unit.BatteryDischargingPower = 0;
      unit.AcInActivePower = 0;
    }
    const primary = units[0];
    if (primary) {
      if (signedWallW > 0) {
        primary.AcChargingPower = magnitudeDw;
        primary.AcInActivePower = -magnitudeDw;
      } else if (signedWallW < 0) {
        primary.BatteryDischargingPower = magnitudeDw;
        primary.AcInActivePower = magnitudeDw;
      }
    }
    if (!this.frame.SSumInfoList) this.frame.SSumInfoList = {};
    const summary = this.frame.SSumInfoList;
    summary.TotalACChargePower = signedWallW > 0 ? magnitudeW : 0;
    summary.TotalBatteryOutputPower = signedWallW < 0 ? magnitudeW : 0;
    summary.TotalGridOutputPower =
      signedWallW > 0 ? -magnitudeW : signedWallW < 0 ? magnitudeW : 0;
  }

  // Overrides exactly the next EnergyParameter poll body, then reverts.
  injectRawFrame(frame: unknown): void {
    this.pendingRawFrame = frame;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close(err => (err ? reject(err) : resolve()));
    });
  }

  private attach(): void {
    this.server.on('connection', socket => this.onConnection(socket));
  }

  private onConnection(socket: net.Socket): void {
    const refuse = this.options.refuseSecondConnection ?? true;
    if (refuse && this.activeSocket && !this.activeSocket.destroyed) {
      // Real behaviour of a second connect attempt is unverified; this
      // models the strictest plausible single-session enforcement.
      socket.destroy();
      return;
    }
    this.activeSocket = socket;
    this.sockets.add(socket);
    socket.setNoDelay(true);

    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf-8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        this.handleRequest(socket, line, parsed);
      }
    });
    socket.on('error', () => {
      // A destroyed/refused second connection raises ECONNRESET locally;
      // it is expected and must not fail the test process.
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (this.activeSocket === socket) this.activeSocket = null;
    });
  }

  private handleRequest(
    socket: net.Socket,
    raw: string,
    parsed: unknown
  ): void {
    this.requests.push({ raw, parsed, at: Date.now() });
    this.requestCounter += 1;

    if (parsed && typeof parsed === 'object') {
      const req = parsed as Record<string, unknown>;
      const serial =
        typeof req.SerialNumber === 'number' ? req.SerialNumber : 0;
      const target =
        typeof req.CommandSource === 'string' ? req.CommandSource : '';

      if (req.Get === 'EnergyParameter') {
        this.respond(socket, this.buildEnergyParameterResponse(serial, target));
      } else if (req.Get === 'Energycontrolparameters') {
        const addrs = Array.isArray(req.RegControlAddr)
          ? (req.RegControlAddr as number[])
          : [];
        this.respond(
          socket,
          this.buildControlInfoResponse(serial, target, addrs)
        );
      } else if (req.Set === 'Energycontrolparameters') {
        this.applySet(req.SetControlInfo);
        if (!this.shouldDropWrite()) {
          this.respond(socket, this.buildSetAckResponse(serial, target));
        }
      } else if (req.Get === 'DeviceManagement') {
        if (!this.options.deviceManagementTimeout) {
          const addrs = Array.isArray(req.RegDeviceManagementAddr)
            ? (req.RegDeviceManagementAddr as number[])
            : [];
          this.respond(
            socket,
            this.buildDeviceManagementResponse(serial, target, addrs)
          );
        }
      }
    }

    this.maybeResetConnection(socket);
  }

  private applySet(setControlInfo: unknown): void {
    if (!setControlInfo || typeof setControlInfo !== 'object') return;
    for (const [reg, value] of Object.entries(
      setControlInfo as Record<string, unknown>
    )) {
      this.registers.set(reg, String(value));
    }
  }

  // Deterministic drop schedule: an accumulator crosses 1.0 on a fixed
  // cadence instead of a random draw, so dropWriteRate is reproducible.
  private shouldDropWrite(): boolean {
    const rate = this.options.dropWriteRate ?? 0;
    if (rate <= 0) return false;
    this.dropAccumulator += rate;
    if (this.dropAccumulator >= 1) {
      this.dropAccumulator -= 1;
      return true;
    }
    return false;
  }

  // Models a device that drops the TCP session after N requests. Unverified
  // against real hardware; exists so reconnect logic can be exercised.
  private maybeResetConnection(socket: net.Socket): void {
    const n = this.options.resetEveryNRequests;
    if (!n || n <= 0) return;
    if (this.requestCounter % n === 0 && !socket.destroyed) {
      socket.destroy();
    }
  }

  private buildEnergyParameterResponse(
    serial: number,
    target: string
  ): Record<string, unknown> {
    if (this.pendingRawFrame !== null) {
      const injected = this.pendingRawFrame;
      this.pendingRawFrame = null;
      const body =
        injected && typeof injected === 'object'
          ? (injected as Record<string, unknown>)
          : {};
      return {
        Response: 'EnergyParameter',
        SerialNumber: serial,
        Target: target,
        ...body,
      };
    }
    const body: Record<string, unknown> = {
      Response: 'EnergyParameter',
      SerialNumber: serial,
      Target: target,
    };
    if (!this.options.omitStorageList && this.frame.Storage_list) {
      body.Storage_list = this.frame.Storage_list;
    }
    if (this.frame.SSumInfoList) {
      body.SSumInfoList = this.frame.SSumInfoList;
    }
    return body;
  }

  private buildControlInfoResponse(
    serial: number,
    target: string,
    addrs: number[]
  ): Record<string, unknown> {
    const controlInfo: Record<string, string> = {};
    for (const addr of addrs) {
      const value = this.registers.get(String(addr));
      if (value !== undefined) controlInfo[String(addr)] = value;
    }
    return {
      Response: 'Energycontrolparameters',
      SerialNumber: serial,
      Target: target,
      ControlInfo: controlInfo,
    };
  }

  // The real ACK envelope is undocumented: the client only checks for a
  // non-null response, so no client may depend on this exact shape.
  private buildSetAckResponse(
    serial: number,
    target: string
  ): Record<string, unknown> {
    return {
      Response: 'Energycontrolparameters',
      SerialNumber: serial,
      Target: target,
      ControlState: 'success',
    };
  }

  private buildDeviceManagementResponse(
    serial: number,
    target: string,
    addrs: number[]
  ): Record<string, unknown> {
    const controlInfo: Record<string, string> = {};
    for (const addr of addrs) {
      // Registers 56/57 hold WiFi credentials on real hardware; the safe
      // whitelist excludes them, so they can never reach this response.
      if (!SAFE_DM_REGISTERS.has(addr)) continue;
      const value = this.registers.get(String(addr));
      if (value !== undefined) controlInfo[String(addr)] = value;
    }
    return {
      Response: 'DeviceManagement',
      SerialNumber: serial,
      Target: target,
      ControlInfo: controlInfo,
    };
  }

  private respond(socket: net.Socket, body: Record<string, unknown>): void {
    const json = JSON.stringify(body);
    const send = (): void => {
      if (socket.destroyed) return;
      const n = Math.max(1, this.options.splitResponseInto ?? 1);
      if (n <= 1) {
        socket.write(json);
      } else {
        void this.writeSplit(socket, json, n);
      }
    };
    const delay = this.options.responseDelayMs ?? 0;
    if (delay > 0) setTimeout(send, delay);
    else send();
  }

  // Writes the response across N socket.write calls, waiting for each to
  // flush before the next, so a client must accumulate to reparse it.
  private async writeSplit(
    socket: net.Socket,
    json: string,
    n: number
  ): Promise<void> {
    const size = Math.max(1, Math.ceil(json.length / n));
    for (let i = 0; i < json.length; i += size) {
      if (socket.destroyed) return;
      const chunk = json.slice(i, i + size);
      await new Promise<void>(resolve => {
        socket.write(chunk, () => resolve());
      });
    }
  }
}

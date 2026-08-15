import { AeccClient, RequestQueue } from './transport/client';
import type { SocketFactory } from './transport/connection';
import type { Logger } from './logger';
import { silentLogger } from './logger';
import type { BrandId, DeviceIdentity, Direction, EnergyFrame } from './types';
import { CLEANERS, type CleanerContext } from './protocol/cleaners';
import { getBrandProfile } from './protocol/brands';
import { FrameGuard, type FrameGuardStats } from './protocol/frame-guard';
import {
  derive,
  parseEnergyFrame,
  systemValue,
  wallPowerSignalW,
  type DerivedTelemetry,
} from './protocol/telemetry';
import {
  compareVerify,
  planMaxSoc,
  planMinSoc,
  planSetpoint,
  planWorkMode,
  type ControlPayload,
  type SetpointLimits,
  type VerifyEntry,
  type WorkMode,
} from './protocol/control';
import { decodeSlot } from './protocol/slot';
import { readRegister, unwrapContainer } from './protocol/frames';
import {
  REG_AI_SMART_CHARGE,
  REG_AI_SMART_DISC,
  REG_CONTROL_TIME1,
  REG_CUSTOM_MODE,
  REG_EMS_ENABLE,
  REG_MAX_SOC,
  REG_MIN_SOC,
  REG_SCHEDULE_MODE,
} from './protocol/registers';

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 2000;
const DEFAULT_VERIFY_INTERVAL_MS = 60000;
const RSSI_REFRESH_INTERVAL_MS = 60000;
const FAILURE_TOLERANCE = 5;
const WRITE_VERIFY_DELAY_MS = 500;
const WRITE_RETRY_ATTEMPTS = 2;
const WRITE_RETRY_DELAY_MS = 1000;
const WRITE_RETRY_OUTAGE_STREAK = 3;
const WRITE_HISTORY_MAX = 20;

// Opaque timer handle: never inspected, only ever round-tripped back to
// clearTimeout. Kept as unknown (not a Node type) so this stays swappable
// for homey.setTimeout's own handle type.
export type SchedulerHandle = unknown;

/**
 * All time/scheduling in this module goes through this interface, never a
 * bare setTimeout, so it is fake-timer testable and Homey can pass
 * this.homey.setTimeout for cleanup on unload.
 */
export interface Scheduler {
  setTimeout(handler: () => void, ms: number): SchedulerHandle;
  clearTimeout(handle: SchedulerHandle): void;
  now(): number;
}

// Real-timer Scheduler, handy for integration tests and any non-Homey host.
export const systemScheduler: Scheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
};

export interface AeccSessionOptions {
  host: string;
  port: number;
  brand: BrandId;
  limits: SetpointLimits;
  scheduler: Scheduler;
  pollIntervalMs?: number;
  verifyIntervalMs?: number;
  startDelayMs?: number;
  logger?: Logger;
  // Transport tuning passthrough. Production omits these and gets the
  // ported defaults; tests use them for short real timeouts instead of
  // mixing fake timers with the real simulator's socket I/O.
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  deviceManagementTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  closeGraceMs?: number;
  socketFactory?: SocketFactory;
}

export interface AeccSessionUpdatableOptions {
  pollIntervalMs?: number;
  verifyIntervalMs?: number;
  limits?: SetpointLimits;
  brand?: BrandId;
}

export interface SessionSnapshot {
  brand: BrandId;
  telemetry: DerivedTelemetry | null;
  identity: DeviceIdentity | null;
  workMode: WorkMode | null;
  commandedTargetPowerW: number;
  minSoc: number;
  maxSoc: number;
  hasStorageList: boolean;
  available: boolean;
  consecutiveFailedPolls: number;
  lastPollAtMs: number | null;
  lastGoodPollAtMs: number | null;
  frameGuard: FrameGuardStats;
}

export interface WriteHistoryEntry {
  timestampMs: number;
  operation: string;
  payload: ControlPayload;
  attempts: number;
  ok: boolean;
  verify: VerifyEntry[] | null;
}

export type SessionEvent =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'available' }
  | { type: 'unavailable'; reason: string }
  | {
      type: 'write';
      operation: string;
      ok: boolean;
      attempts: number;
      verify: VerifyEntry[] | null;
    }
  // Emitted only by the periodic drift check, so consumers never have to infer
  // a correction from the surrounding write events. Both values are signed in
  // the Homey convention: positive charges, negative discharges.
  | { type: 'drift'; expectedPowerW: number; foundPowerW: number };

export type SessionListener = (event: SessionEvent) => void;

function directionOf(targetPowerW: number): Direction {
  return targetPowerW > 0 ? 'charge' : targetPowerW < 0 ? 'discharge' : 'idle';
}

/**
 * Polling and control orchestrator for one AECC device: self-rescheduling
 * poll loop, frame validation/cleaning, and serialised writes with retry and
 * post-write verification.
 */
export class AeccSession {
  private readonly client: AeccClient;
  private readonly scheduler: Scheduler;
  private readonly logger: Logger;
  private readonly frameGuard = new FrameGuard();
  private readonly writeQueue = new RequestQueue();
  private readonly listeners = new Set<SessionListener>();
  private readonly cleanerLastAccepted = new Map<string, number>();
  private readonly cleanerLastAcceptedAt = new Map<string, number>();
  private writeHistoryEntries: WriteHistoryEntry[] = [];

  private brand: BrandId;
  private limits: SetpointLimits;
  private pollIntervalMs: number;
  private verifyIntervalMs: number;
  private readonly startDelayMs: number;

  private stopped = true;
  private pollTimerHandle: SchedulerHandle | null = null;

  private telemetry: DerivedTelemetry | null = null;
  private identity: DeviceIdentity | null = null;
  private workMode: WorkMode | null = null;
  private commandedTargetPowerW = 0;
  private minSoc = 10;
  private maxSoc = 100;
  private hasStorageList = false;
  private rssiSupported = false;

  private consecutiveFailedPolls = 0;
  private unavailableEmitted = false;
  private lastPollAtMs: number | null = null;
  private lastGoodPollAtMs: number | null = null;
  private lastRssiRefreshAtMs: number | null = null;
  private lastDriftCheckAtMs: number | null = null;

  constructor(options: AeccSessionOptions) {
    this.brand = options.brand;
    this.limits = options.limits;
    this.scheduler = options.scheduler;
    this.logger = options.logger ?? silentLogger;
    this.pollIntervalMs = Math.max(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS
    );
    this.verifyIntervalMs =
      options.verifyIntervalMs ?? DEFAULT_VERIFY_INTERVAL_MS;
    this.startDelayMs = options.startDelayMs ?? 0;
    this.client = new AeccClient({
      host: options.host,
      port: options.port,
      connectTimeoutMs: options.connectTimeoutMs,
      readTimeoutMs: options.readTimeoutMs,
      deviceManagementTimeoutMs: options.deviceManagementTimeoutMs,
      backoffBaseMs: options.backoffBaseMs,
      backoffMaxMs: options.backoffMaxMs,
      closeGraceMs: options.closeGraceMs,
      socketFactory: options.socketFactory,
      logger: this.logger,
    });
  }

  get snapshot(): SessionSnapshot {
    return {
      brand: this.brand,
      telemetry: this.telemetry,
      identity: this.identity,
      workMode: this.workMode,
      commandedTargetPowerW: this.commandedTargetPowerW,
      minSoc: this.minSoc,
      maxSoc: this.maxSoc,
      hasStorageList: this.hasStorageList,
      available: !this.unavailableEmitted,
      consecutiveFailedPolls: this.consecutiveFailedPolls,
      lastPollAtMs: this.lastPollAtMs,
      lastGoodPollAtMs: this.lastGoodPollAtMs,
      frameGuard: this.frameGuard.stats,
    };
  }

  get writeHistory(): WriteHistoryEntry[] {
    return [...this.writeHistoryEntries];
  }

  subscribe(fn: SessionListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.startDelayMs > 0) await this.sleep(this.startDelayMs);
    if (this.stopped) return;

    await this.runPollCycle();
    await this.readInitialState();
    await this.probeIdentity();
    if (this.stopped) return;

    this.schedulePoll(this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimerHandle !== null) {
      this.scheduler.clearTimeout(this.pollTimerHandle);
      this.pollTimerHandle = null;
    }
    await this.client.disconnect();
  }

  updateOptions(patch: AeccSessionUpdatableOptions): void {
    if (patch.pollIntervalMs !== undefined) {
      this.pollIntervalMs = Math.max(
        patch.pollIntervalMs,
        MIN_POLL_INTERVAL_MS
      );
    }
    if (patch.verifyIntervalMs !== undefined) {
      this.verifyIntervalMs = patch.verifyIntervalMs;
    }
    if (patch.limits !== undefined) {
      this.limits = patch.limits;
    }
    if (patch.brand !== undefined) {
      this.brand = patch.brand;
    }
  }

  async readInitialState(): Promise<void> {
    const resp = await this.client.getControlParameters([
      Number(REG_EMS_ENABLE),
      Number(REG_CONTROL_TIME1),
      Number(REG_AI_SMART_CHARGE),
      Number(REG_AI_SMART_DISC),
      Number(REG_MIN_SOC),
      Number(REG_MAX_SOC),
      Number(REG_CUSTOM_MODE),
    ]);
    if (resp === null) return;
    const params = unwrapContainer(resp, 'control');
    if (params === null) return;

    const minSocRaw = readRegister(params, REG_MIN_SOC);
    const maxSocRaw = readRegister(params, REG_MAX_SOC);
    const aiCharge = readRegister(params, REG_AI_SMART_CHARGE);
    const aiDischarge = readRegister(params, REG_AI_SMART_DISC);
    const slotRaw = readRegister(params, REG_CONTROL_TIME1);

    if (minSocRaw !== undefined) {
      const parsed = Number(minSocRaw);
      if (Number.isFinite(parsed)) this.minSoc = parsed;
    }
    if (maxSocRaw !== undefined) {
      const parsed = Number(maxSocRaw);
      if (Number.isFinite(parsed)) this.maxSoc = parsed;
    }
    if (slotRaw !== undefined) {
      const decoded = decodeSlot(slotRaw);
      if (decoded !== null) {
        this.commandedTargetPowerW =
          decoded.direction === 'charge'
            ? decoded.powerW
            : decoded.direction === 'discharge'
              ? -decoded.powerW
              : 0;
      }
    }
    this.workMode =
      aiCharge === '1' || aiDischarge === '1' ? 'self_consumption' : 'custom';
    this.emitSnapshot();
  }

  async probeIdentity(): Promise<void> {
    const identity = await this.client.getDeviceIdentity();
    if (identity === null) return;
    this.identity = identity;
    if (identity.rssi !== undefined) this.rssiSupported = true;
    this.emitSnapshot();
  }

  async setTargetPower(watts: number): Promise<boolean> {
    this.commandedTargetPowerW = watts;
    const ok = await this.reapplySetpoint();
    if (ok) this.workMode = 'custom';
    this.emitSnapshot();
    return ok;
  }

  async setWorkMode(mode: WorkMode): Promise<boolean> {
    const payload = planWorkMode(mode, this.brand);
    const ok = await this.loggedWrite(payload, `work_mode(${mode})`);
    if (!ok) return false;
    this.workMode = mode;
    if (mode === 'custom') {
      const reapplied = await this.reapplySetpoint();
      this.emitSnapshot();
      return reapplied;
    }
    this.emitSnapshot();
    return true;
  }

  async setMinSoc(pct: number): Promise<boolean> {
    this.minSoc = pct;
    const ok = await this.loggedWrite(planMinSoc(pct), `min_soc(${pct}%)`);
    this.emitSnapshot();
    return ok;
  }

  async setMaxSoc(pct: number): Promise<boolean> {
    this.maxSoc = pct;
    const ok = await this.loggedWrite(planMaxSoc(pct), `max_soc(${pct}%)`);
    this.emitSnapshot();
    return ok;
  }

  async reapplySetpoint(): Promise<boolean> {
    const plan = planSetpoint({
      targetPowerW: this.commandedTargetPowerW,
      brand: this.brand,
      limits: this.limits,
      hasStorageList: this.hasStorageList,
      minSoc: this.minSoc,
      maxSoc: this.maxSoc,
    });
    const ok = await this.loggedWrite(
      plan.payload,
      `battery_control(${plan.direction}, ${plan.powerW}W)`
    );
    this.emitSnapshot();
    return ok;
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => {
      this.scheduler.setTimeout(() => resolve(), ms);
    });
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    this.pollTimerHandle = this.scheduler.setTimeout(() => {
      this.pollTimerHandle = null;
      void this.runPollCycle().then(() => {
        this.schedulePoll(this.pollIntervalMs);
      });
    }, delayMs);
  }

  private async runPollCycle(): Promise<void> {
    const nowMs = this.scheduler.now();
    this.lastPollAtMs = nowMs;
    const raw = await this.client.getEnergyParameters();
    const frame = raw !== null ? parseEnergyFrame(raw) : null;

    if (frame === null) {
      this.consecutiveFailedPolls += 1;
      this.maybeEmitUnavailable();
      this.emitSnapshot();
      return;
    }

    this.consecutiveFailedPolls = 0;
    this.maybeEmitAvailable();

    const guarded = this.frameGuard.accept(frame);
    this.applyFrame(guarded.frame, nowMs);
    this.lastGoodPollAtMs = nowMs;

    await this.maybeRefreshRssi(nowMs);
    await this.maybeCheckDrift(nowMs);

    this.emitSnapshot();
  }

  private applyFrame(frame: EnergyFrame, nowMs: number): void {
    const wallPowerW = wallPowerSignalW(frame);
    const rawSoc = systemValue(frame, 'battery_soc');
    const cleanedSoc =
      rawSoc === undefined
        ? null
        : this.runCleaner('battery_soc', rawSoc, wallPowerW, nowMs);
    this.telemetry = derive(frame, cleanedSoc);
    this.hasStorageList = (frame.Storage_list ?? []).length > 0;
  }

  private runCleaner(
    key: string,
    rawValue: number,
    wallPowerW: number | null,
    nowMs: number
  ): number | null {
    const cleaner = CLEANERS[key];
    if (!cleaner) return rawValue;
    const ctx: CleanerContext = {
      key,
      rawValue,
      lastAcceptedValue: this.cleanerLastAccepted.get(key) ?? null,
      lastAcceptedAtMs: this.cleanerLastAcceptedAt.get(key) ?? null,
      nowMs,
      wallPowerW,
      profile: getBrandProfile(this.brand),
    };
    const cleaned = cleaner(ctx);
    if (cleaned === null) return null;
    this.cleanerLastAccepted.set(key, cleaned);
    this.cleanerLastAcceptedAt.set(key, nowMs);
    return cleaned;
  }

  private maybeEmitUnavailable(): void {
    if (this.unavailableEmitted) return;
    if (this.consecutiveFailedPolls < FAILURE_TOLERANCE) return;
    this.unavailableEmitted = true;
    this.emit({
      type: 'unavailable',
      reason: `no valid response from device after ${this.consecutiveFailedPolls} consecutive failed polls`,
    });
  }

  private maybeEmitAvailable(): void {
    if (!this.unavailableEmitted) return;
    this.unavailableEmitted = false;
    this.emit({ type: 'available' });
  }

  private async maybeRefreshRssi(nowMs: number): Promise<void> {
    if (!this.rssiSupported) return;
    if (
      this.lastRssiRefreshAtMs !== null &&
      nowMs - this.lastRssiRefreshAtMs < RSSI_REFRESH_INTERVAL_MS
    ) {
      return;
    }
    this.lastRssiRefreshAtMs = nowMs;
    const identity = await this.client.getDeviceIdentity();
    if (identity !== null) {
      this.identity = { ...this.identity, ...identity };
    }
  }

  // New versus the ported Python: roughly 2% of writes are silently dropped
  // in the field and the vendor app can overwrite the slot from elsewhere,
  // so a custom-mode setpoint is periodically re-verified against the
  // device and re-applied if it has drifted.
  private async maybeCheckDrift(nowMs: number): Promise<void> {
    if (this.verifyIntervalMs <= 0) return;
    if (this.workMode !== 'custom') return;
    if (
      this.lastDriftCheckAtMs !== null &&
      nowMs - this.lastDriftCheckAtMs < this.verifyIntervalMs
    ) {
      return;
    }
    this.lastDriftCheckAtMs = nowMs;

    const resp = await this.client.getControlParameters([
      Number(REG_CONTROL_TIME1),
      Number(REG_SCHEDULE_MODE),
      Number(REG_CUSTOM_MODE),
    ]);
    if (resp === null) return;
    const params = unwrapContainer(resp, 'control');
    if (params === null) return;
    const slotRaw = readRegister(params, REG_CONTROL_TIME1);
    if (slotRaw === undefined) return;
    const decoded = decodeSlot(slotRaw);
    if (decoded === null) return;

    const expectedDirection = directionOf(this.commandedTargetPowerW);
    const expectedPowerW = Math.min(
      Math.abs(this.commandedTargetPowerW),
      expectedDirection === 'charge'
        ? this.limits.maxChargeW
        : expectedDirection === 'discharge'
          ? this.limits.maxDischargeW
          : 0
    );

    const disagrees =
      decoded.direction !== expectedDirection ||
      (expectedDirection !== 'idle' && decoded.powerW !== expectedPowerW);
    if (!disagrees) return;

    const signed = (direction: Direction, magnitude: number): number =>
      direction === 'charge'
        ? magnitude
        : direction === 'discharge'
          ? -magnitude
          : 0;

    this.emit({
      type: 'drift',
      expectedPowerW: signed(expectedDirection, expectedPowerW),
      foundPowerW: signed(decoded.direction, decoded.powerW),
    });

    await this.reapplySetpoint();
  }

  private async loggedWrite(
    payload: ControlPayload,
    operation: string
  ): Promise<boolean> {
    return this.writeQueue.run(async () => {
      let attempts = 0;
      let resp: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt <= WRITE_RETRY_ATTEMPTS; attempt += 1) {
        attempts = attempt + 1;
        resp = await this.client.setControlParameters(payload);
        if (resp !== null) break;
        if (attempt >= WRITE_RETRY_ATTEMPTS) break;
        if (this.client.consecutiveFailures >= WRITE_RETRY_OUTAGE_STREAK) break;
        await this.sleep(WRITE_RETRY_DELAY_MS);
      }

      const ok = resp !== null;
      const verify = ok ? await this.verifyWrite(payload, operation) : null;
      this.recordWrite({
        timestampMs: this.scheduler.now(),
        operation,
        payload,
        attempts,
        ok,
        verify,
      });
      this.emit({ type: 'write', operation, ok, attempts, verify });
      return ok;
    });
  }

  private async verifyWrite(
    expected: ControlPayload,
    _operation: string
  ): Promise<VerifyEntry[] | null> {
    await this.sleep(WRITE_VERIFY_DELAY_MS);
    const regAddrs = Object.keys(expected).map(Number);
    const resp = await this.client.getControlParameters(regAddrs);
    if (resp === null) return null;
    const actual = unwrapContainer(resp, 'control');
    if (actual === null) return null;
    return compareVerify(expected, actual);
  }

  private recordWrite(entry: WriteHistoryEntry): void {
    this.writeHistoryEntries.push(entry);
    if (this.writeHistoryEntries.length > WRITE_HISTORY_MAX) {
      this.writeHistoryEntries.shift();
    }
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitSnapshot(): void {
    this.emit({ type: 'snapshot', snapshot: this.snapshot });
  }
}

export interface EnergyIntegratorState {
  chargedKwh: number;
  dischargedKwh: number;
}

export interface EnergyIntegratorOptions {
  maxGapMs?: number;
}

const DEFAULT_MAX_GAP_MS = 60_000;
// W * ms -> kWh: 1 kWh = 1000W * 3600s * 1000ms/s = 3.6e9 W*ms.
const KWH_DIVISOR = 3.6e9;

// Riemann-sum energy integrator. lastSampleAtMs is in-memory only and is
// never serialised, so a restart cannot integrate the downtime gap.
export class EnergyIntegrator {
  private chargedKwhValue: number;
  private dischargedKwhValue: number;
  private readonly maxGapMs: number;
  private lastSampleAtMs: number | null = null;

  constructor(state?: EnergyIntegratorState, opts?: EnergyIntegratorOptions) {
    this.chargedKwhValue = state?.chargedKwh ?? 0;
    this.dischargedKwhValue = state?.dischargedKwh ?? 0;
    this.maxGapMs = opts?.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  }

  sample(nowMs: number, signedPowerW: number): boolean {
    const prevAt = this.lastSampleAtMs;
    this.lastSampleAtMs = nowMs;

    if (prevAt === null) return false;
    if (!Number.isFinite(signedPowerW)) return false;
    const dtMs = nowMs - prevAt;
    if (!(dtMs > 0)) return false;
    if (dtMs > this.maxGapMs) return false;

    this.chargedKwhValue += (Math.max(signedPowerW, 0) * dtMs) / KWH_DIVISOR;
    this.dischargedKwhValue +=
      (Math.max(-signedPowerW, 0) * dtMs) / KWH_DIVISOR;
    return true;
  }

  get chargedKwh(): number {
    return this.chargedKwhValue;
  }

  get dischargedKwh(): number {
    return this.dischargedKwhValue;
  }

  serialize(): EnergyIntegratorState {
    return {
      chargedKwh: this.chargedKwhValue,
      dischargedKwh: this.dischargedKwhValue,
    };
  }

  reset(): void {
    this.chargedKwhValue = 0;
    this.dischargedKwhValue = 0;
    this.lastSampleAtMs = null;
  }
}

export interface ProductionIntegratorState {
  generatedKwh: number;
}

/**
 * One-direction Riemann-sum integrator for generated energy.
 *
 * A separate class rather than a reuse of EnergyIntegrator: the solar
 * device charges and discharges nothing, so persisting a
 * {chargedKwh, dischargedKwh} pair for it would bake a lie into its store
 * shape and cost a migration to undo. lastSampleAtMs is in-memory only
 * here too, so a restart cannot integrate its own downtime.
 */
export class ProductionIntegrator {
  private generatedKwhValue: number;
  private readonly maxGapMs: number;
  private lastSampleAtMs: number | null = null;

  constructor(
    state?: ProductionIntegratorState,
    opts?: EnergyIntegratorOptions
  ) {
    this.generatedKwhValue = state?.generatedKwh ?? 0;
    this.maxGapMs = opts?.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  }

  // A negative reading contributes nothing rather than winding the counter
  // back: Homey reads a negative measure_power on a solar device as
  // consumption, and an energy total must never run backwards. The
  // timestamp still advances, so the next interval integrates cleanly.
  sample(nowMs: number, powerW: number): boolean {
    const prevAt = this.lastSampleAtMs;
    this.lastSampleAtMs = nowMs;

    if (prevAt === null) return false;
    if (!Number.isFinite(powerW)) return false;
    const dtMs = nowMs - prevAt;
    if (!(dtMs > 0)) return false;
    if (dtMs > this.maxGapMs) return false;

    this.generatedKwhValue += (Math.max(powerW, 0) * dtMs) / KWH_DIVISOR;
    return true;
  }

  get generatedKwh(): number {
    return this.generatedKwhValue;
  }

  serialize(): ProductionIntegratorState {
    return { generatedKwh: this.generatedKwhValue };
  }

  reset(): void {
    this.generatedKwhValue = 0;
    this.lastSampleAtMs = null;
  }
}

// Below this delta or this interval since the last flush, a snapshot does
// not warrant a store write: kWh counters barely move every 2-300s poll.
export const METER_PERSIST_DELTA_KWH = 0.005;
export const METER_PERSIST_INTERVAL_MS = 60_000;

export interface ShouldPersistMeterInput {
  currentChargedKwh: number;
  currentDischargedKwh: number;
  lastPersistedChargedKwh: number;
  lastPersistedDischargedKwh: number;
  nowMs: number;
  lastPersistedAtMs: number;
}

/** True when either counter crossed METER_PERSIST_DELTA_KWH or the interval elapsed. */
export function shouldPersistMeter(input: ShouldPersistMeterInput): boolean {
  const {
    currentChargedKwh,
    currentDischargedKwh,
    lastPersistedChargedKwh,
    lastPersistedDischargedKwh,
    nowMs,
    lastPersistedAtMs,
  } = input;

  const chargedDelta = Math.abs(currentChargedKwh - lastPersistedChargedKwh);
  const dischargedDelta = Math.abs(
    currentDischargedKwh - lastPersistedDischargedKwh
  );
  const dueByTime = nowMs - lastPersistedAtMs >= METER_PERSIST_INTERVAL_MS;

  return (
    chargedDelta >= METER_PERSIST_DELTA_KWH ||
    dischargedDelta >= METER_PERSIST_DELTA_KWH ||
    dueByTime
  );
}

export interface ShouldPersistProductionMeterInput {
  currentGeneratedKwh: number;
  lastPersistedGeneratedKwh: number;
  nowMs: number;
  lastPersistedAtMs: number;
}

/**
 * The single-counter equivalent of shouldPersistMeter, sharing its two
 * thresholds. Kept separate rather than generalising the battery's version,
 * which every existing install depends on.
 */
export function shouldPersistProductionMeter(
  input: ShouldPersistProductionMeterInput
): boolean {
  const {
    currentGeneratedKwh,
    lastPersistedGeneratedKwh,
    nowMs,
    lastPersistedAtMs,
  } = input;

  const generatedDelta = Math.abs(
    currentGeneratedKwh - lastPersistedGeneratedKwh
  );
  const dueByTime = nowMs - lastPersistedAtMs >= METER_PERSIST_INTERVAL_MS;

  return generatedDelta >= METER_PERSIST_DELTA_KWH || dueByTime;
}

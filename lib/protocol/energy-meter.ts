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

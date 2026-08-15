import type { EnergyFrame, StorageUnit } from '../types';
import { frameUnits, unitKey } from './telemetry';

export interface FrameGuardOptions {
  tolerance?: number;
  socCollapseFloor?: number;
}

export interface FrameGuardResult {
  frame: EnergyFrame;
  held: boolean;
  suspectReason: string | null;
}

export interface FrameGuardStats {
  suspectFramesTotal: number;
  lastReason: string | null;
  lastAt: string | null;
}

const DEFAULT_TOLERANCE = 3;
const DEFAULT_SOC_COLLAPSE_FLOOR = 5;

// Non-sensitive unit identifier for suspect-reason strings: DevAddr first,
// truncated serial fallback. Never emits a full serial number.
function unitLabel(unit: StorageUnit): string {
  if (unit.DevAddr !== undefined) return `DevAddr ${unit.DevAddr}`;
  return `SN ending ${unitKey(unit).slice(-4)}`;
}

// Holds a genuinely faulty poll frame (unit missing, SOC collapsed to 0)
// behind the last good frame, but accepts a changed frame once the suspect
// streak exceeds tolerance so a removed unit still becomes visible.
export class FrameGuard {
  private readonly tolerance: number;
  private readonly socCollapseFloor: number;
  private lastGood: EnergyFrame | null = null;
  private suspectStreak = 0;
  private suspectFramesTotal = 0;
  private lastReason: string | null = null;
  private lastAt: string | null = null;

  constructor(options: FrameGuardOptions = {}) {
    this.tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    this.socCollapseFloor =
      options.socCollapseFloor ?? DEFAULT_SOC_COLLAPSE_FLOOR;
  }

  accept(frame: EnergyFrame): FrameGuardResult {
    const reason = this.suspectReason(frame);
    if (reason === null) {
      this.suspectStreak = 0;
      this.lastGood = frame;
      return { frame, held: false, suspectReason: null };
    }

    if (this.suspectStreak < this.tolerance) {
      this.suspectStreak += 1;
      this.suspectFramesTotal += 1;
      this.lastReason = reason;
      this.lastAt = new Date().toISOString();
      // Safe: suspectReason only returns non-null when lastGood is set.
      return {
        frame: this.lastGood as EnergyFrame,
        held: true,
        suspectReason: reason,
      };
    }

    this.suspectStreak = 0;
    this.lastGood = frame;
    return { frame, held: false, suspectReason: reason };
  }

  private suspectReason(frame: EnergyFrame): string | null {
    if (this.lastGood === null) return null;
    const lastUnits = new Map(
      frameUnits(this.lastGood).map(u => [unitKey(u), u])
    );
    if (lastUnits.size === 0) return null;
    const newUnits = new Map(frameUnits(frame).map(u => [unitKey(u), u]));

    const missing: string[] = [];
    for (const [key, unit] of lastUnits) {
      if (!newUnits.has(key)) missing.push(unitLabel(unit));
    }
    if (missing.length > 0) {
      return `unit(s) missing from Storage_list: ${missing.join(', ')}`;
    }

    for (const [key, unit] of newUnits) {
      const lastUnit = lastUnits.get(key);
      if (!lastUnit) continue;
      const newSoc = Number(unit.BatterySoc);
      const lastSoc = Number(lastUnit.BatterySoc);
      if (!Number.isFinite(newSoc) || !Number.isFinite(lastSoc)) continue;
      if (newSoc === 0 && lastSoc >= this.socCollapseFloor) {
        return `unit ${unitLabel(unit)} SOC collapsed from ${lastSoc} to 0`;
      }
    }
    return null;
  }

  get stats(): FrameGuardStats {
    return {
      suspectFramesTotal: this.suspectFramesTotal,
      lastReason: this.lastReason,
      lastAt: this.lastAt,
    };
  }
}

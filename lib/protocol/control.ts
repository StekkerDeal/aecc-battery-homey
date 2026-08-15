import type { BrandId, Direction } from '../types';
import { scheduleModeCustom } from './brands';
import { readRegister } from './frames';
import {
  MAX_REGISTER_POWER_DEFAULT,
  REG_AI_SMART_CHARGE,
  REG_AI_SMART_DISC,
  REG_CONTROL_TIME1,
  REG_CUSTOM_MODE,
  REG_EMS_ENABLE,
  REG_MAX_FEED_POWER,
  REG_MAX_SOC,
  REG_MIN_SOC,
  REG_SCHEDULE_MODE,
  SLOT_DISABLED,
} from './registers';
import { encodeSlot } from './slot';

export type ControlPayload = Record<string, string>;

export interface SetpointLimits {
  maxChargeW: number;
  maxDischargeW: number;
}

export interface PlanSetpointInput {
  /** Homey convention: positive = charge, negative = discharge, 0 = idle. */
  targetPowerW: number;
  brand: BrandId;
  limits: SetpointLimits;
  hasStorageList: boolean;
  minSoc: number;
  maxSoc: number;
}

export interface SetpointPlan {
  payload: ControlPayload;
  direction: Direction;
  powerW: number;
  clamped: boolean;
  slot: string;
}

export function planSetpoint(input: PlanSetpointInput): SetpointPlan {
  const { targetPowerW, brand, limits, hasStorageList, minSoc, maxSoc } = input;

  const direction: Direction =
    targetPowerW > 0 ? 'charge' : targetPowerW < 0 ? 'discharge' : 'idle';
  const limit =
    direction === 'charge' ? limits.maxChargeW : limits.maxDischargeW;
  const magnitude = Math.abs(targetPowerW);
  const clamped = direction !== 'idle' && magnitude > limit;
  const powerW = clamped ? limit : magnitude;

  const field7 = hasStorageList ? 5 : 4;
  const slot = encodeSlot({
    direction,
    powerW,
    brand,
    field7,
    chargeSoc: maxSoc,
    dischargeSoc: minSoc,
  });

  const payload: ControlPayload = {
    [REG_EMS_ENABLE]: '1',
    [REG_SCHEDULE_MODE]: scheduleModeCustom(brand),
    [REG_AI_SMART_CHARGE]: '0',
    [REG_AI_SMART_DISC]: '0',
    [REG_CUSTOM_MODE]: '1',
    [REG_CONTROL_TIME1]: slot,
  };

  // 3039 lifts the device's local power cap; only written when the larger of
  // the two direction limits exceeds the default so a stock 800W device
  // never gets a redundant write.
  const maxRegisterPower = Math.max(limits.maxChargeW, limits.maxDischargeW);
  if (maxRegisterPower > MAX_REGISTER_POWER_DEFAULT) {
    payload[REG_MAX_FEED_POWER] = String(maxRegisterPower);
  }

  return { payload, direction, powerW, clamped, slot };
}

export type WorkMode = 'self_consumption' | 'custom';

export function planWorkMode(mode: WorkMode, brand: BrandId): ControlPayload {
  if (mode === 'self_consumption') {
    // Clearing 3003 here is mandatory: without it the firmware keeps running
    // the old manual setpoint instead of handing control back to the AI.
    return {
      [REG_EMS_ENABLE]: '1',
      [REG_SCHEDULE_MODE]: '3',
      [REG_AI_SMART_CHARGE]: '1',
      [REG_AI_SMART_DISC]: '1',
      [REG_CUSTOM_MODE]: '0',
      [REG_CONTROL_TIME1]: SLOT_DISABLED,
    };
  }
  return {
    [REG_EMS_ENABLE]: '1',
    [REG_SCHEDULE_MODE]: scheduleModeCustom(brand),
    [REG_AI_SMART_CHARGE]: '0',
    [REG_AI_SMART_DISC]: '0',
    [REG_CUSTOM_MODE]: '1',
  };
}

export function planMinSoc(value: number): ControlPayload {
  return { [REG_MIN_SOC]: String(value) };
}

export function planMaxSoc(value: number): ControlPayload {
  return { [REG_MAX_SOC]: String(value) };
}

export interface VerifyEntry {
  register: string;
  expected: string;
  actual: string | undefined;
  match: boolean | null;
}

// 3003 is log-only: the device normalises the slot string (whitespace,
// trailing zeros), so it is never compared character-for-character.
export function compareVerify(
  expected: ControlPayload,
  actual: Record<string, unknown>
): VerifyEntry[] {
  return Object.entries(expected).map(([register, expectedVal]) => {
    const actualVal = readRegister(actual, register);
    if (register === REG_CONTROL_TIME1) {
      return {
        register,
        expected: expectedVal,
        actual: actualVal,
        match: null,
      };
    }
    if (actualVal === undefined) {
      return {
        register,
        expected: expectedVal,
        actual: undefined,
        match: null,
      };
    }
    return {
      register,
      expected: expectedVal,
      actual: actualVal,
      match: actualVal.trim() === expectedVal.trim(),
    };
  });
}

import type { Logger } from '../logger';
import { silentLogger } from '../logger';

/**
 * Fixed contract the device layer implements. Flow run listeners call only
 * these methods, never protocol code directly.
 */
export interface AeccFlowDevice {
  setChargePower(watts: number): Promise<void>;
  setDischargePower(watts: number): Promise<void>;
  stopBattery(): Promise<void>;
  setSocLimits(minSoc: number, maxSoc: number): Promise<void>;
  reapplySetpoint(): Promise<void>;
  isFresh(seconds: number): boolean;
}

/** Card ids as declared in driver.flow.compose.json, single source of truth. */
export const FLOW_TRIGGER_IDS = {
  controlWriteFailed: 'control_write_failed',
  controlDriftCorrected: 'control_drift_corrected',
  readingsBecameStale: 'readings_became_stale',
} as const;

export const FLOW_CONDITION_IDS = {
  readingsAreFresh: 'readings_are_fresh',
} as const;

export const FLOW_ACTION_IDS = {
  setChargePower: 'set_charge_power',
  setDischargePower: 'set_discharge_power',
  stopBattery: 'stop_battery',
  setSocLimits: 'set_soc_limits',
  reapplySetpoint: 'reapply_setpoint',
} as const;

// Structural, minimal view of the Homey Flow API this file needs. Kept
// loose (not the real SDK types) so lib/ stays importable without Homey.
// TArgs is supplied per call site below instead of using `any`, since args
// shape differs per card.
export interface FlowCardActionLike<TArgs> {
  registerRunListener(
    listener: (args: TArgs, state: unknown) => Promise<unknown> | unknown
  ): unknown;
}

export interface FlowCardConditionLike<TArgs> {
  registerRunListener(
    listener: (args: TArgs, state: unknown) => Promise<boolean> | boolean
  ): unknown;
}

export interface FlowCardTriggerDeviceLike {
  trigger(device: unknown, tokens?: object, state?: object): Promise<unknown>;
}

export interface FlowHost {
  flow: {
    getActionCard<TArgs = unknown>(id: string): FlowCardActionLike<TArgs>;
    getConditionCard<TArgs = unknown>(id: string): FlowCardConditionLike<TArgs>;
    getDeviceTriggerCard(id: string): FlowCardTriggerDeviceLike;
  };
}

export interface RegisterFlowCardsDeps {
  logger?: Logger;
}

interface WithDevice {
  device: AeccFlowDevice;
}

/** Registers the run listener for every driver-scoped action and condition card. */
export function registerFlowCards(
  homey: FlowHost,
  deps: RegisterFlowCardsDeps = {}
): void {
  const logger = deps.logger ?? silentLogger;

  homey.flow
    .getActionCard<WithDevice & { power: number }>(
      FLOW_ACTION_IDS.setChargePower
    )
    .registerRunListener(async args => {
      await args.device.setChargePower(args.power);
    });

  homey.flow
    .getActionCard<WithDevice & { power: number }>(
      FLOW_ACTION_IDS.setDischargePower
    )
    .registerRunListener(async args => {
      await args.device.setDischargePower(args.power);
    });

  homey.flow
    .getActionCard<WithDevice>(FLOW_ACTION_IDS.stopBattery)
    .registerRunListener(async args => {
      await args.device.stopBattery();
    });

  homey.flow
    .getActionCard<WithDevice & { min_soc: number; max_soc: number }>(
      FLOW_ACTION_IDS.setSocLimits
    )
    .registerRunListener(async args => {
      await args.device.setSocLimits(args.min_soc, args.max_soc);
    });

  homey.flow
    .getActionCard<WithDevice>(FLOW_ACTION_IDS.reapplySetpoint)
    .registerRunListener(async args => {
      await args.device.reapplySetpoint();
    });

  homey.flow
    .getConditionCard<WithDevice & { seconds: number }>(
      FLOW_CONDITION_IDS.readingsAreFresh
    )
    .registerRunListener(args => {
      return args.device.isFresh(args.seconds);
    });

  logger.log('Flow cards registered');
}

export interface ControlWriteFailedTokens {
  operation: string;
  attempts: number;
}

export interface ControlDriftCorrectedTokens {
  expected: number;
  found: number;
}

export interface ReadingsBecameStaleTokens {
  seconds: number;
}

export function triggerControlWriteFailed(
  homey: FlowHost,
  device: unknown,
  tokens: ControlWriteFailedTokens
): Promise<unknown> {
  return homey.flow
    .getDeviceTriggerCard(FLOW_TRIGGER_IDS.controlWriteFailed)
    .trigger(device, tokens);
}

export function triggerControlDriftCorrected(
  homey: FlowHost,
  device: unknown,
  tokens: ControlDriftCorrectedTokens
): Promise<unknown> {
  return homey.flow
    .getDeviceTriggerCard(FLOW_TRIGGER_IDS.controlDriftCorrected)
    .trigger(device, tokens);
}

export function triggerReadingsBecameStale(
  homey: FlowHost,
  device: unknown,
  tokens: ReadingsBecameStaleTokens
): Promise<unknown> {
  return homey.flow
    .getDeviceTriggerCard(FLOW_TRIGGER_IDS.readingsBecameStale)
    .trigger(device, tokens);
}

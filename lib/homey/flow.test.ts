import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  FLOW_ACTION_IDS,
  FLOW_CONDITION_IDS,
  FLOW_TRIGGER_IDS,
  registerFlowCards,
  triggerControlDriftCorrected,
  triggerControlWriteFailed,
  triggerReadingsBecameStale,
  type AeccFlowDevice,
  type FlowHost,
} from './flow';

// Type-erased storage for registered listeners: FlowHost's getActionCard and
// getConditionCard are generic per card (args shape differs per card), so
// the concrete TArgs is only known inside the generic method body. Casting
// to RunListener there is the one deliberate boundary where that per-card
// type is erased for map storage; every call site below supplies the
// concrete args shape again when invoking the stored listener.
type RunListener = (args: unknown, state?: unknown) => unknown;

type TriggerFn = (
  device: unknown,
  tokens?: object,
  state?: object
) => Promise<unknown>;

function createFakeHomey() {
  const actionListeners = new Map<string, RunListener>();
  const conditionListeners = new Map<string, RunListener>();
  const triggerCards = new Map<string, { trigger: Mock<TriggerFn> }>();

  function getOrCreateTriggerCard(id: string) {
    let card = triggerCards.get(id);
    if (!card) {
      card = { trigger: vi.fn<TriggerFn>().mockResolvedValue(undefined) };
      triggerCards.set(id, card);
    }
    return card;
  }

  const homey: FlowHost = {
    flow: {
      getActionCard<TArgs>(id: string) {
        return {
          registerRunListener(
            listener: (args: TArgs, state: unknown) => unknown
          ) {
            actionListeners.set(id, listener as RunListener);
          },
        };
      },
      getConditionCard<TArgs>(id: string) {
        return {
          registerRunListener(
            listener: (
              args: TArgs,
              state: unknown
            ) => boolean | Promise<boolean>
          ) {
            conditionListeners.set(id, listener as RunListener);
          },
        };
      },
      getDeviceTriggerCard: (id: string) => getOrCreateTriggerCard(id),
    },
  };

  return { homey, actionListeners, conditionListeners, triggerCards };
}

function createFakeDevice(): AeccFlowDevice &
  Record<keyof AeccFlowDevice, ReturnType<typeof vi.fn>> {
  return {
    setChargePower: vi.fn().mockResolvedValue(undefined),
    setDischargePower: vi.fn().mockResolvedValue(undefined),
    stopBattery: vi.fn().mockResolvedValue(undefined),
    setSocLimits: vi.fn().mockResolvedValue(undefined),
    reapplySetpoint: vi.fn().mockResolvedValue(undefined),
    isFresh: vi.fn().mockReturnValue(true),
  };
}

describe('registerFlowCards', () => {
  it('set_charge_power calls device.setChargePower with the power argument', async () => {
    const { homey, actionListeners } = createFakeHomey();
    registerFlowCards(homey);
    const device = createFakeDevice();

    await actionListeners.get(FLOW_ACTION_IDS.setChargePower)?.({
      device,
      power: 800,
    });

    expect(device.setChargePower).toHaveBeenCalledWith(800);
  });

  it('set_discharge_power calls device.setDischargePower with the power argument', async () => {
    const { homey, actionListeners } = createFakeHomey();
    registerFlowCards(homey);
    const device = createFakeDevice();

    await actionListeners.get(FLOW_ACTION_IDS.setDischargePower)?.({
      device,
      power: 650,
    });

    expect(device.setDischargePower).toHaveBeenCalledWith(650);
  });

  it('stop_battery calls device.stopBattery with no arguments', async () => {
    const { homey, actionListeners } = createFakeHomey();
    registerFlowCards(homey);
    const device = createFakeDevice();

    await actionListeners.get(FLOW_ACTION_IDS.stopBattery)?.({ device });

    expect(device.stopBattery).toHaveBeenCalledWith();
  });

  it('set_soc_limits calls device.setSocLimits with min_soc and max_soc, in order', async () => {
    const { homey, actionListeners } = createFakeHomey();
    registerFlowCards(homey);
    const device = createFakeDevice();

    await actionListeners.get(FLOW_ACTION_IDS.setSocLimits)?.({
      device,
      min_soc: 15,
      max_soc: 90,
    });

    expect(device.setSocLimits).toHaveBeenCalledWith(15, 90);
  });

  it('reapply_setpoint calls device.reapplySetpoint with no arguments', async () => {
    const { homey, actionListeners } = createFakeHomey();
    registerFlowCards(homey);
    const device = createFakeDevice();

    await actionListeners.get(FLOW_ACTION_IDS.reapplySetpoint)?.({ device });

    expect(device.reapplySetpoint).toHaveBeenCalledWith();
  });

  it('readings_are_fresh returns whatever device.isFresh returns, for the given seconds', () => {
    const { homey, conditionListeners } = createFakeHomey();
    registerFlowCards(homey);
    const device = createFakeDevice();
    device.isFresh.mockReturnValue(true);

    const result = conditionListeners.get(
      FLOW_CONDITION_IDS.readingsAreFresh
    )?.({
      device,
      seconds: 300,
    });

    expect(device.isFresh).toHaveBeenCalledWith(300);
    expect(result).toBe(true);
  });

  it('readings_are_fresh propagates a false result from device.isFresh', () => {
    const { homey, conditionListeners } = createFakeHomey();
    registerFlowCards(homey);
    const device = createFakeDevice();
    device.isFresh.mockReturnValue(false);

    const result = conditionListeners.get(
      FLOW_CONDITION_IDS.readingsAreFresh
    )?.({
      device,
      seconds: 30,
    });

    expect(result).toBe(false);
  });

  it('logs registration through the supplied logger', () => {
    const { homey } = createFakeHomey();
    const logger = { log: vi.fn(), error: vi.fn() };

    registerFlowCards(homey, { logger });

    expect(logger.log).toHaveBeenCalledWith('Flow cards registered');
  });

  it('does not throw when no logger is supplied', () => {
    const { homey } = createFakeHomey();
    expect(() => registerFlowCards(homey)).not.toThrow();
  });
});

describe('trigger helpers', () => {
  it('triggerControlWriteFailed triggers control_write_failed with operation and attempts', async () => {
    const { homey, triggerCards } = createFakeHomey();
    const device = createFakeDevice();

    await triggerControlWriteFailed(homey, device, {
      operation: 'set_charge_power',
      attempts: 3,
    });

    expect(
      triggerCards.get(FLOW_TRIGGER_IDS.controlWriteFailed)?.trigger
    ).toHaveBeenCalledWith(device, {
      operation: 'set_charge_power',
      attempts: 3,
    });
  });

  it('triggerControlDriftCorrected triggers control_drift_corrected with expected and found', async () => {
    const { homey, triggerCards } = createFakeHomey();
    const device = createFakeDevice();

    await triggerControlDriftCorrected(homey, device, {
      expected: 800,
      found: 0,
    });

    expect(
      triggerCards.get(FLOW_TRIGGER_IDS.controlDriftCorrected)?.trigger
    ).toHaveBeenCalledWith(device, { expected: 800, found: 0 });
  });

  it('triggerReadingsBecameStale triggers readings_became_stale with seconds', async () => {
    const { homey, triggerCards } = createFakeHomey();
    const device = createFakeDevice();

    await triggerReadingsBecameStale(homey, device, { seconds: 120 });

    expect(
      triggerCards.get(FLOW_TRIGGER_IDS.readingsBecameStale)?.trigger
    ).toHaveBeenCalledWith(device, { seconds: 120 });
  });
});

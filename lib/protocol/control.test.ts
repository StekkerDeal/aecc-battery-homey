import { describe, expect, it } from 'vitest';
import {
  compareVerify,
  planMaxSoc,
  planMinSoc,
  planSetpoint,
  planWorkMode,
  type ControlPayload,
} from './control';
import {
  REG_AI_SMART_CHARGE,
  REG_AI_SMART_DISC,
  REG_CONTROL_TIME1,
  REG_CUSTOM_MODE,
  REG_MAX_FEED_POWER,
  REG_MAX_SOC,
  REG_MIN_SOC,
  REG_SCHEDULE_MODE,
} from './registers';

const limits = { maxChargeW: 800, maxDischargeW: 800 };

describe('planSetpoint', () => {
  it('does not include 3039 at or below the 800W default', () => {
    const plan = planSetpoint({
      targetPowerW: 500,
      brand: 'jet',
      limits,
      hasStorageList: true,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(plan.payload[REG_MAX_FEED_POWER]).toBeUndefined();
  });

  it('includes 3039 only when a limit exceeds 800W', () => {
    const plan = planSetpoint({
      targetPowerW: 500,
      brand: 'jet',
      limits: { maxChargeW: 2400, maxDischargeW: 800 },
      hasStorageList: true,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(plan.payload[REG_MAX_FEED_POWER]).toBe('2400');
  });

  it('clamps asymmetrically per direction', () => {
    const asymLimits = { maxChargeW: 500, maxDischargeW: 2000 };

    const charge = planSetpoint({
      targetPowerW: 800,
      brand: 'jet',
      limits: asymLimits,
      hasStorageList: true,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(charge.clamped).toBe(true);
    expect(charge.powerW).toBe(500);

    const discharge = planSetpoint({
      targetPowerW: -800,
      brand: 'jet',
      limits: asymLimits,
      hasStorageList: true,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(discharge.clamped).toBe(false);
    expect(discharge.powerW).toBe(800);
  });

  it('does not clamp a value under the limit', () => {
    const plan = planSetpoint({
      targetPowerW: 400,
      brand: 'jet',
      limits,
      hasStorageList: true,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(plan.clamped).toBe(false);
    expect(plan.powerW).toBe(400);
  });

  it('uses 3020=3 on aeg and 3020=6 on every other brand', () => {
    const aeg = planSetpoint({
      targetPowerW: 400,
      brand: 'aeg',
      limits,
      hasStorageList: true,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(aeg.payload[REG_SCHEDULE_MODE]).toBe('3');

    const jet = planSetpoint({
      targetPowerW: 400,
      brand: 'jet',
      limits,
      hasStorageList: true,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(jet.payload[REG_SCHEDULE_MODE]).toBe('6');
  });

  it('resolves direction from the sign of targetPowerW', () => {
    expect(
      planSetpoint({
        targetPowerW: 400,
        brand: 'jet',
        limits,
        hasStorageList: true,
        minSoc: 10,
        maxSoc: 90,
      }).direction
    ).toBe('charge');
    expect(
      planSetpoint({
        targetPowerW: -400,
        brand: 'jet',
        limits,
        hasStorageList: true,
        minSoc: 10,
        maxSoc: 90,
      }).direction
    ).toBe('discharge');
    expect(
      planSetpoint({
        targetPowerW: 0,
        brand: 'jet',
        limits,
        hasStorageList: true,
        minSoc: 10,
        maxSoc: 90,
      }).direction
    ).toBe('idle');
  });

  it('picks field7=5 when hasStorageList is true and 4 otherwise', () => {
    const withList = planSetpoint({
      targetPowerW: 400,
      brand: 'jet',
      limits,
      hasStorageList: true,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(withList.slot.split(',')[6]).toBe('5');

    const withoutList = planSetpoint({
      targetPowerW: 400,
      brand: 'jet',
      limits,
      hasStorageList: false,
      minSoc: 10,
      maxSoc: 90,
    });
    expect(withoutList.slot.split(',')[6]).toBe('4');
  });

  it('carries chargeSoc and dischargeSoc from maxSoc and minSoc into the slot', () => {
    const plan = planSetpoint({
      targetPowerW: 400,
      brand: 'jet',
      limits,
      hasStorageList: true,
      minSoc: 15,
      maxSoc: 95,
    });
    const parts = plan.slot.split(',');
    expect(parts[9]).toBe('95');
    expect(parts[10]).toBe('15');
  });
});

describe('planWorkMode', () => {
  it('self_consumption clears 3003 and enables AI charge/discharge', () => {
    const payload = planWorkMode('self_consumption', 'jet');
    expect(payload[REG_CONTROL_TIME1]).toBe('0,00:00,00:00,0,0,0,0,0,0,100,10');
    expect(payload[REG_SCHEDULE_MODE]).toBe('3');
    expect(payload[REG_AI_SMART_CHARGE]).toBe('1');
    expect(payload[REG_AI_SMART_DISC]).toBe('1');
    expect(payload[REG_CUSTOM_MODE]).toBe('0');
  });

  it('custom disables AI and enables custom mode, without touching 3003', () => {
    const payload = planWorkMode('custom', 'jet');
    expect(payload[REG_CONTROL_TIME1]).toBeUndefined();
    expect(payload[REG_SCHEDULE_MODE]).toBe('6');
    expect(payload[REG_AI_SMART_CHARGE]).toBe('0');
    expect(payload[REG_AI_SMART_DISC]).toBe('0');
    expect(payload[REG_CUSTOM_MODE]).toBe('1');
  });

  it('custom uses 3020=3 on aeg', () => {
    expect(planWorkMode('custom', 'aeg')[REG_SCHEDULE_MODE]).toBe('3');
  });
});

describe('planMinSoc / planMaxSoc', () => {
  it('planMinSoc returns register 3023 as a string', () => {
    expect(planMinSoc(15)).toEqual({ [REG_MIN_SOC]: '15' });
  });

  it('planMaxSoc returns register 3024 as a string', () => {
    expect(planMaxSoc(95)).toEqual({ [REG_MAX_SOC]: '95' });
  });
});

describe('compareVerify', () => {
  it('returns match: null for register 3003 regardless of content', () => {
    const expected: ControlPayload = {
      [REG_CONTROL_TIME1]: '1,00:00,23:59,-800,0,6,5,0,0,80,10',
    };
    const actual = {
      [REG_CONTROL_TIME1]: '1,00:00,23:59,-800,0,6,5,0,0,80,10 ',
    };
    const entries = compareVerify(expected, actual);
    expect(entries[0]).toEqual({
      register: REG_CONTROL_TIME1,
      expected: expected[REG_CONTROL_TIME1],
      actual: actual[REG_CONTROL_TIME1],
      match: null,
    });
  });

  it('matches other registers after trimming whitespace', () => {
    const expected: ControlPayload = { '3000': '1' };
    const actual = { '3000': ' 1 ' };
    expect(compareVerify(expected, actual)).toEqual([
      { register: '3000', expected: '1', actual: ' 1 ', match: true },
    ]);
  });

  it('reports a mismatch when the device value differs', () => {
    const expected: ControlPayload = { '3000': '1' };
    const actual = { '3000': '0' };
    expect(compareVerify(expected, actual)).toEqual([
      { register: '3000', expected: '1', actual: '0', match: false },
    ]);
  });

  it('reports match: null when the register is absent from the readback', () => {
    const expected: ControlPayload = { '3000': '1' };
    expect(compareVerify(expected, {})).toEqual([
      { register: '3000', expected: '1', actual: undefined, match: null },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import type { EnergyFrame, StorageUnit } from '../types';
import {
  derive,
  frameUnits,
  parseEnergyFrame,
  systemValue,
  unitKey,
  unitValue,
  wallPowerSignalW,
} from './telemetry';

const jetUnit: StorageUnit = {
  DevAddr: 1,
  StorageSN: 'JET-SN-0001',
  BatterySoc: 55,
  AcChargingPower: 7980,
  BatteryChargingPower: 7900,
  BatteryDischargingPower: 0,
  PvChargingPower: 0,
  AcInActivePower: 0,
  OffGridLoadPower: 0,
  Pv1Power: 0,
  Pv2Power: 0,
};

describe('parseEnergyFrame', () => {
  it('accepts a frame with a non-empty Storage_list', () => {
    const raw = { Storage_list: [jetUnit] };
    expect(parseEnergyFrame(raw)).toEqual(raw);
  });

  it('accepts a Lunergy-shaped frame with only SSumInfoList', () => {
    const raw = { SSumInfoList: { AverageBatteryAverageSOC: 42 } };
    expect(parseEnergyFrame(raw)).toEqual(raw);
  });

  it('rejects a frame with neither Storage_list nor SSumInfoList', () => {
    expect(parseEnergyFrame({})).toBeNull();
    expect(parseEnergyFrame({ Storage_list: [] })).toBeNull();
    expect(parseEnergyFrame({ SSumInfoList: {} })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseEnergyFrame(null)).toBeNull();
    expect(parseEnergyFrame(undefined)).toBeNull();
    expect(parseEnergyFrame('nope')).toBeNull();
  });
});

describe('frameUnits / unitKey', () => {
  it('returns an empty array when Storage_list is absent', () => {
    expect(frameUnits({})).toEqual([]);
  });

  it('keys a unit by StorageSN', () => {
    expect(unitKey(jetUnit)).toBe('JET-SN-0001');
  });

  it('falls back to addr<DevAddr> when StorageSN is absent', () => {
    expect(unitKey({ DevAddr: 7 })).toBe('addr7');
  });
});

describe('systemValue: JET real-frame scale regression', () => {
  it('prefers the summary field over the raw storage deciwatt value', () => {
    const frame: EnergyFrame = {
      Storage_list: [jetUnit],
      SSumInfoList: { TotalACChargePower: 798 },
    };
    expect(systemValue(frame, 'ac_charging_power')).toBe(798);
    expect(systemValue(frame, 'ac_charging_power')).not.toBe(7980);
    expect(systemValue(frame, 'ac_charging_power')).not.toBe(-798);
  });

  it('a second real capture: summary 36 vs storage 360 (deciwatts)', () => {
    const frame: EnergyFrame = {
      Storage_list: [{ ...jetUnit, BatteryDischargingPower: 360 }],
      SSumInfoList: { TotalBatteryOutputPower: 36 },
    };
    expect(systemValue(frame, 'battery_discharging_power')).toBe(36);
  });

  it('proves summary priority even when it diverges from the storage aggregate', () => {
    const frame: EnergyFrame = {
      Storage_list: [{ AcChargingPower: 5000 }],
      SSumInfoList: { TotalACChargePower: 42 },
    };
    expect(systemValue(frame, 'ac_charging_power')).toBe(42);
  });
});

describe('systemValue: field map scale conventions', () => {
  it('backup_power multiplies the summary by 10 and storage by 1', () => {
    const withSummary: EnergyFrame = {
      SSumInfoList: { TotalBackUpPower: 183.2 },
    };
    expect(systemValue(withSummary, 'backup_power')).toBe(1832);

    const storageOnly: EnergyFrame = {
      Storage_list: [{ OffGridLoadPower: 2000 }],
    };
    expect(systemValue(storageOnly, 'backup_power')).toBe(2000);
  });

  it('pv1_power multiplies storage by 1 and has no summary field', () => {
    const frame: EnergyFrame = {
      Storage_list: [{ Pv1Power: 340 }],
      SSumInfoList: { Pv1Power: 9999 },
    };
    expect(systemValue(frame, 'pv1_power')).toBe(340);
  });

  it('never reads TotalChargePower for battery_charging_power', () => {
    const frame: EnergyFrame = {
      Storage_list: [{ BatteryChargingPower: 50 }],
      SSumInfoList: { TotalChargePower: 9999 },
    };
    expect(systemValue(frame, 'battery_charging_power')).toBe(5);
  });

  it('averages battery_soc across units instead of summing', () => {
    const frame: EnergyFrame = {
      Storage_list: [{ BatterySoc: 40 }, { BatterySoc: 60 }],
    };
    expect(systemValue(frame, 'battery_soc')).toBe(50);
  });

  it('produces system values for a Lunergy-shaped frame with no Storage_list', () => {
    const frame: EnergyFrame = {
      SSumInfoList: {
        AverageBatteryAverageSOC: 47,
        TotalACChargePower: 100,
        TotalBatteryOutputPower: 0,
      },
    };
    expect(systemValue(frame, 'battery_soc')).toBe(47);
    expect(systemValue(frame, 'ac_charging_power')).toBe(100);
  });

  it('returns undefined when neither summary nor storage has the field', () => {
    expect(systemValue({}, 'pv2_power')).toBeUndefined();
  });

  it('ignores non-finite summary values and falls back to storage', () => {
    const frame: EnergyFrame = {
      Storage_list: [{ AcChargingPower: 100 }],
      SSumInfoList: { TotalACChargePower: 'nope' },
    };
    expect(systemValue(frame, 'ac_charging_power')).toBe(10);
  });

  it('ignores non-finite storage values in aggregation', () => {
    const frame: EnergyFrame = {
      Storage_list: [{ Pv1Power: 10 }, { Pv1Power: Number.NaN }],
    };
    expect(systemValue(frame, 'pv1_power')).toBe(10);
  });
});

describe('unitValue', () => {
  it('reads a scaled value for a specific unit by key', () => {
    const frame: EnergyFrame = { Storage_list: [jetUnit] };
    expect(unitValue(frame, 'JET-SN-0001', 'ac_charging_power')).toBe(798);
  });

  it('returns undefined for an unknown unit key', () => {
    const frame: EnergyFrame = { Storage_list: [jetUnit] };
    expect(
      unitValue(frame, 'nonexistent', 'ac_charging_power')
    ).toBeUndefined();
  });

  it('returns undefined when the field is missing on the matched unit', () => {
    const frame: EnergyFrame = { Storage_list: [{ StorageSN: 'X' }] };
    expect(unitValue(frame, 'X', 'ac_charging_power')).toBeUndefined();
  });
});

describe('wallPowerSignalW', () => {
  it('returns a positive signal from AC charging power', () => {
    const frame: EnergyFrame = { Storage_list: [{ AcChargingPower: 100 }] };
    expect(wallPowerSignalW(frame)).toBe(10);
  });

  it('returns a positive signal from battery charging power when AC is absent', () => {
    const frame: EnergyFrame = { Storage_list: [{ BatteryChargingPower: 50 }] };
    expect(wallPowerSignalW(frame)).toBe(5);
  });

  it('returns a negative signal from discharging power', () => {
    const frame: EnergyFrame = {
      Storage_list: [{ BatteryDischargingPower: 80 }],
    };
    expect(wallPowerSignalW(frame)).toBe(-8);
  });

  it('falls back to the summary fields when storage has no activity', () => {
    const frame: EnergyFrame = { SSumInfoList: { TotalACChargePower: 200 } };
    expect(wallPowerSignalW(frame)).toBe(200);
  });

  it('falls back to a negative summary discharge signal', () => {
    const frame: EnergyFrame = {
      SSumInfoList: { TotalBatteryOutputPower: 150 },
    };
    expect(wallPowerSignalW(frame)).toBe(-150);
  });

  it('returns 0 when summary fields are present but both zero', () => {
    const frame: EnergyFrame = {
      SSumInfoList: { TotalACChargePower: 0, TotalBatteryOutputPower: 0 },
    };
    expect(wallPowerSignalW(frame)).toBe(0);
  });

  it('returns null when no source has data', () => {
    expect(wallPowerSignalW({})).toBeNull();
  });
});

describe('derive', () => {
  it('computes measurePowerW as max(charge, acCharge) - discharge, positive = charging', () => {
    const frame: EnergyFrame = {
      Storage_list: [
        {
          BatteryChargingPower: 1000,
          AcChargingPower: 5000,
          BatteryDischargingPower: 0,
        },
      ],
    };
    const result = derive(frame, 55);
    expect(result.measurePowerW).toBe(500);
    expect(result.chargingState).toBe('charging');
    expect(result.socPct).toBe(55);
  });

  it('reports discharging when the discharge signal dominates', () => {
    const frame: EnergyFrame = {
      Storage_list: [
        {
          BatteryChargingPower: 0,
          AcChargingPower: 0,
          BatteryDischargingPower: 8000,
        },
      ],
    };
    const result = derive(frame, 40);
    expect(result.measurePowerW).toBe(-800);
    expect(result.chargingState).toBe('discharging');
  });

  it('reports idle when there is a power signal but it nets to zero', () => {
    const frame: EnergyFrame = { SSumInfoList: { TotalACChargePower: 0 } };
    const result = derive(frame, 50);
    expect(result.measurePowerW).toBe(0);
    expect(result.chargingState).toBe('idle');
  });

  // A stopped battery idles at a few watts of standby draw, measured at 10W
  // charging and -5W discharging on the JET, so an exact-zero test would have
  // left the tile permanently reading charging or discharging.
  it('calls standby draw inside the deadband idle without hiding it from measure_power', () => {
    const frame: EnergyFrame = {
      Storage_list: [
        {
          BatteryChargingPower: 100,
          AcChargingPower: 0,
          BatteryDischargingPower: 0,
        },
      ],
    };
    const result = derive(frame, 50);
    expect(result.measurePowerW).toBe(10);
    expect(result.chargingState).toBe('idle');
  });

  it('calls standby discharge inside the deadband idle', () => {
    const frame: EnergyFrame = {
      Storage_list: [
        {
          BatteryChargingPower: 0,
          AcChargingPower: 0,
          BatteryDischargingPower: 50,
        },
      ],
    };
    const result = derive(frame, 50);
    expect(result.measurePowerW).toBe(-5);
    expect(result.chargingState).toBe('idle');
  });

  it('reports charging and discharging just outside the deadband', () => {
    const charging = derive(
      {
        Storage_list: [
          {
            BatteryChargingPower: 260,
            AcChargingPower: 0,
            BatteryDischargingPower: 0,
          },
        ],
      },
      50
    );
    expect(charging.measurePowerW).toBe(26);
    expect(charging.chargingState).toBe('charging');

    const discharging = derive(
      {
        Storage_list: [
          {
            BatteryChargingPower: 0,
            AcChargingPower: 0,
            BatteryDischargingPower: 260,
          },
        ],
      },
      50
    );
    expect(discharging.measurePowerW).toBe(-26);
    expect(discharging.chargingState).toBe('discharging');
  });

  it('reports a null chargingState when there is no power signal at all', () => {
    const result = derive({}, null);
    expect(result.chargingState).toBeNull();
    expect(result.measurePowerW).toBeNull();
    expect(result.socPct).toBeNull();
  });

  // Absent is not zero: a model without PV or backup must not publish 0 W for
  // them, and the device layer keys optional capabilities off these nulls.
  it('leaves unreported readings null instead of defaulting them to zero', () => {
    const result = derive(
      { SSumInfoList: { AverageBatteryAverageSOC: 40 } },
      40
    );
    expect(result.pvPowerW).toBeNull();
    expect(result.pv1PowerW).toBeNull();
    expect(result.pv2PowerW).toBeNull();
    expect(result.backupPowerW).toBeNull();
    expect(result.gridPowerW).toBeNull();
    expect(result.gridExportW).toBeNull();
  });

  it('derives grid export as the positive magnitude of a negative grid power', () => {
    const frame: EnergyFrame = {
      SSumInfoList: { MeterTotalActivePower: -500 },
    };
    const result = derive(frame, null);
    expect(result.gridPowerW).toBe(-500);
    expect(result.gridExportW).toBe(500);
  });

  it('reports zero export when importing from the grid', () => {
    const frame: EnergyFrame = { SSumInfoList: { MeterTotalActivePower: 300 } };
    expect(derive(frame, null).gridExportW).toBe(0);
  });

  it('reports unitCount and hasStorageList from Storage_list', () => {
    const frame: EnergyFrame = {
      Storage_list: [jetUnit, { ...jetUnit, StorageSN: 'JET-SN-0002' }],
    };
    const result = derive(frame, null);
    expect(result.unitCount).toBe(2);
    expect(result.hasStorageList).toBe(true);
  });

  it('reports hasStorageList false for a Lunergy-shaped frame', () => {
    const frame: EnergyFrame = {
      SSumInfoList: { AverageBatteryAverageSOC: 40 },
    };
    const result = derive(frame, 40);
    expect(result.hasStorageList).toBe(false);
    expect(result.unitCount).toBe(0);
  });

  it('reports pv, pv1, pv2 and backup power from the field map', () => {
    const frame: EnergyFrame = {
      SSumInfoList: { TotalPVPower: 400, TotalBackUpPower: 50 },
      Storage_list: [{ Pv1Power: 100, Pv2Power: 200 }],
    };
    const result = derive(frame, null);
    expect(result.pvPowerW).toBe(400);
    expect(result.pv1PowerW).toBe(100);
    expect(result.pv2PowerW).toBe(200);
    expect(result.backupPowerW).toBe(500);
  });
});
